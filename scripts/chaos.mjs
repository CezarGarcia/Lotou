/**
 * Experimentos de caos (docs/projeto.md, "Caos"): cada um provoca uma falha no ambiente do
 * Compose no ar, observa e confere sozinho o resultado esperado, e deixa o ambiente como estava.
 *
 * Uso: `make chaos EXP=<experimento>` (ou `EXP=todos`), depois de `make up` e `make seed` no dia.
 * Roda no host: usa o Docker Compose para parar e subir containers, a API pelo gateway e o
 * Grafana para conferir métricas, traces e alertas. Os e-mails dos alertas chegam ao Mailpit.
 *
 * Experimentos:
 *   notificacao-fora        notification-service fora por CHAOS_DOWN_SECONDS (padrão 300)
 *   pagamento-recusando     payment-mock recusando 30% dos pagamentos
 *   estorno-falhando        payment-mock falhando todos os estornos (leva uns 6 minutos)
 *   pedidos-fora            order-service fora no dia do show: a portaria segue validando
 *   portaria-sem-consumir   consumidor de order.events (checkin-service) derrubado
 *   redis-core-reiniciado   redis-core reiniciado no meio da abertura de vendas
 *   postgres-lento          500 ms de latência entre o order-service e o Postgres (Toxiproxy)
 *   mensagem-malformada     uma mensagem que não é JSON em order.events
 */
import { execSync, spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { shows as seedShows } from '../seed/data.mjs';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const GRAFANA = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const TOXIPROXY = process.env.TOXIPROXY_URL ?? 'http://localhost:8474';
const COMPOSE = process.env.COMPOSE ?? 'docker compose';
const DOWN_SECONDS = Number(process.env.CHAOS_DOWN_SECONDS ?? 300);
const API = `${GATEWAY}/api/v1`;
const USER_AGENT = 'lotou-smoke chaos';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const step = (message) => console.log(`   ${message}`);

class Failure extends Error {}
function expect(condition, message) {
  if (!condition) throw new Failure(message);
}

// ------------------------------------------------------------------ ambiente

function compose(args, { quiet = true } = {}) {
  return execSync(`${COMPOSE} ${args}`, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
}

/** Recria um serviço com variáveis trocadas (as do compose usam ${VAR:-padrão}). */
function recreate(service, env = {}) {
  execSync(`${COMPOSE} up -d --no-deps --wait ${service}`, {
    stdio: 'pipe',
    env: { ...process.env, ...env },
  });
}

async function until(description, check, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Failure(`${description}: não aconteceu em ${Math.round(timeoutMs / 1000)} s`);
}

// ------------------------------------------------------------------- API

async function token(grant) {
  const body =
    grant === 'gate'
      ? { grant_type: 'client_credentials', client_id: 'lotou-smoke', client_secret: 'lotou-smoke-dev-secret' }
      : {
          grant_type: 'password',
          client_id: 'lotou-seed',
          client_secret: 'lotou-seed-dev-secret',
          username: grant,
          password: 'lotou123',
        };
  const response = await fetch(`${KEYCLOAK}/realms/lotou/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams(body),
  });
  expect(response.ok, `o Keycloak recusou o login de ${grant}: ${response.status}`);
  return (await response.json()).access_token;
}

async function api(method, path, { token: bearer, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      ...(bearer && { Authorization: `Bearer ${bearer}` }),
      ...(body && { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function cpf() {
  const digits = Array.from({ length: 9 }, () => randomInt(10));
  for (const length of [9, 10]) {
    const sum = digits.slice(0, length).reduce((total, digit, i) => total + digit * (length + 1 - i), 0);
    digits.push(((sum * 10) % 11) % 10);
  }
  return digits.join('');
}

// Só os shows do seed, que são do produtor de demonstração: os testes de carga criam shows de outro dono.
const SEED_ARTISTS = new Set(seedShows.map((show) => show.artist));

/** Um setor de pista à venda num show comum do seed que satisfaz `accept`. */
async function pista(accept) {
  const { body } = await api('GET', '/shows?limit=50');
  for (const show of body.items.filter((item) => SEED_ARTISTS.has(item.artist) && !item.highDemand && accept(item))) {
    const availability = await (await fetch(`${API}/availability/${show.id}`)).json();
    const sector = availability.sectors?.find(
      (item) => item.kind === 'GENERAL_ADMISSION' && item.sale === 'ON_SALE' && item.available > 10,
    );
    if (sector) return { show, sector };
  }
  throw new Failure("nenhum show com pista à venda. Rodou 'make seed' hoje?");
}

const farShow = () => pista((show) => Date.parse(show.startsAt) - Date.now() > 3 * 86_400_000);
const tonightShow = () =>
  pista((show) => Date.parse(show.startsAt) > Date.now() && Date.parse(show.startsAt) - Date.now() < 26 * 3_600_000);

/** Reserva e cria o pedido; não espera a saga. O gateway limita 2 pedidos por segundo por usuário. */
async function place(buyer, { show, sector }, quantity = 1) {
  const reservation = await api('POST', '/reservations', {
    token: buyer,
    body: { showId: show.id, sectorId: sector.id, quantity, cpf: cpf() },
  });
  expect(reservation.status === 201, `reserva recusada: ${reservation.status} ${JSON.stringify(reservation.body)}`);
  const order = await api('POST', '/orders', { token: buyer, body: { reservationId: reservation.body.id } });
  expect(order.status === 201, `pedido recusado: ${order.status} ${JSON.stringify(order.body)}`);
  await sleep(600);
  return order.body;
}

async function order(buyer, id) {
  return (await api('GET', `/orders/${id}`, { token: buyer })).body;
}

async function settled(buyer, id, timeoutMs = 90_000) {
  return until(`pedido ${id} sair de PENDING`, async () => {
    const current = await order(buyer, id);
    return current?.status !== 'PENDING' ? current : null;
  }, { timeoutMs });
}

async function available(show, sector) {
  const availability = await (await fetch(`${API}/availability/${show.id}`)).json();
  return availability.sectors.find((item) => item.id === sector.id).available;
}

async function scan(gate, showId, code, gateName = 'Portão Caos') {
  return (await api('POST', '/checkins', { token: gate, body: { showId, gate: gateName, code } })).body;
}

// ----------------------------------------------------------- observabilidade

async function prometheus(query) {
  const url = `${GRAFANA}/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(query)}`;
  const result = (await (await fetch(url)).json()).data.result;
  return result.length ? Number(result[0].value[1]) : null;
}

async function mails(query) {
  const url = `${MAILPIT}/api/v1/search?query=${encodeURIComponent(query)}&limit=200`;
  // O Mailpit pode piscar quando um serviço volta e reconecta: tenta de novo antes de desistir.
  for (let attempt = 1; ; attempt++) {
    try {
      return (await (await fetch(url)).json()).messages_count ?? 0;
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(2_000);
    }
  }
}

/** Espera o e-mail de um alerta do Grafana chegar ao Mailpit. */
async function alertMail(title, since, timeoutMs = 4 * 60_000) {
  return until(`e-mail do alerta "${title}"`, async () => {
    const url = `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:plantao@lotou.test subject:"${title}"`)}`;
    const found = await fetch(url)
      .then((response) => response.json())
      .then((body) => body.messages ?? [])
      .catch(() => []);
    return found.find((message) => Date.parse(message.Created) >= since);
  }, { timeoutMs, intervalMs: 5_000 });
}

function invariants() {
  const output = execSync(`${COMPOSE} exec -T postgres psql -U lotou -d inventory -At -F '|' -f /dev/stdin`, {
    input: execSync('cat load-tests/check-invariants.sql'),
    encoding: 'utf8',
  });
  return output
    .trim()
    .split('\n')
    .map((line) => line.split('|'))
    .map(([name, count]) => ({ name, count: Number(count) }));
}

function sql(database, query) {
  return execSync(`${COMPOSE} exec -T postgres psql -U lotou -d ${database} -At -c "${query}"`, { encoding: 'utf8' }).trim();
}

// ------------------------------------------------------------ experimentos

const experiments = {
  async 'notificacao-fora'() {
    const buyer = await token('comprador');
    const target = await farShow();
    const before = await mails('to:comprador@lotou.test subject:"Seus ingressos"');
    step(`notification-service parado por ${DOWN_SECONDS} s`);
    compose('stop notification-service');
    try {
      const orders = [];
      for (let i = 0; i < 5; i++) orders.push(await place(buyer, target));
      for (const created of orders) expect((await settled(buyer, created.id)).status === 'CONFIRMED', 'compra não confirmou');
      step('5 compras confirmadas com o serviço de e-mail fora');
      await sleep(DOWN_SECONDS * 1000);
      expect((await mails('to:comprador@lotou.test subject:"Seus ingressos"')) === before, 'chegou e-mail com o serviço parado');
      const lag = await prometheus('max(kafka_consumer_group_lag_sum_ratio{group="notification-service",topic="order.events"})');
      step(`lag do notification-service em order.events: ${lag}`);
    } finally {
      compose('start notification-service');
    }
    step('notification-service de volta');
    await until('os 5 e-mails chegarem', async () => (await mails('to:comprador@lotou.test subject:"Seus ingressos"')) >= before + 5, {
      timeoutMs: 180_000,
      intervalMs: 3_000,
    });
    await sleep(20_000);
    const after = await mails('to:comprador@lotou.test subject:"Seus ingressos"');
    expect(after === before + 5, `esperava ${before + 5} e-mails, chegaram ${after}`);
    step('os 5 e-mails chegaram, nenhum repetido');
  },

  async 'pagamento-recusando'() {
    const buyer = await token('comprador');
    const target = await farShow();
    const stockBefore = await available(target.show, target.sector);
    step('payment-mock recusando 30% dos pagamentos');
    recreate('payment-mock', { PAYMENT_MOCK_DECLINE_RATE: '0.3' });
    let results;
    try {
      const orders = [];
      for (let i = 0; i < 30; i++) orders.push(await place(buyer, target));
      results = await Promise.all(orders.map((created) => settled(buyer, created.id)));
    } finally {
      recreate('payment-mock');
    }
    const confirmed = results.filter((item) => item.status === 'CONFIRMED').length;
    const cancelled = results.filter((item) => item.status === 'CANCELLED').length;
    step(`30 pedidos: ${confirmed} confirmados, ${cancelled} compensados`);
    expect(confirmed + cancelled === 30, 'algum pedido não terminou');
    expect(cancelled > 0, 'nenhum pagamento recusado');
    await until('o estoque refletir só os confirmados', async () =>
      (await available(target.show, target.sector)) === stockBefore - confirmed,
    );
    step(`estoque: ${stockBefore} -> ${stockBefore - confirmed} (os recusados voltaram à venda)`);
    await sleep(3_000);
    for (const { name, count } of invariants()) expect(count === 0, `invariante quebrada: ${name} (${count})`);
    step('invariantes de venda conferidas no Postgres: zero violações');
  },

  async 'estorno-falhando'() {
    const buyer = await token('comprador');
    const target = await farShow();
    const since = Date.now();
    step('payment-mock falhando todos os estornos');
    recreate('payment-mock', { PAYMENT_MOCK_REFUND_FAILURE_RATE: '1' });
    let failed;
    try {
      const created = await place(buyer, target);
      expect((await settled(buyer, created.id)).status === 'CONFIRMED', 'compra não confirmou');
      const cancel = await api('POST', `/orders/${created.id}/cancel`, { token: buyer });
      expect(cancel.status === 202, `cancelamento recusado: ${cancel.status}`);
      step('pedido cancelado; esperando as cinco falhas do estorno (espera crescente, uns 6 minutos)');
      failed = await until('pedido ir para REFUND_FAILED', async () => {
        // A espera passa dos 5 minutos de validade do token: um token novo a cada consulta.
        const current = await order(await token('comprador'), created.id);
        return current.status === 'REFUND_FAILED' ? current : null;
      }, { timeoutMs: 12 * 60_000, intervalMs: 5_000 });
      step(`pedido em REFUND_FAILED depois de ${Math.round((Date.now() - since) / 1000)} s`);
      const mail = await alertMail('Reembolso falhou', since);
      step(`alerta "Reembolso falhou" chegou ao Mailpit às ${new Date(mail.Created).toLocaleTimeString('pt-BR')}`);
    } finally {
      recreate('payment-mock');
    }
    // O token dura 5 minutos e a espera pelas falhas passa disso: pede outro.
    const retry = await api('POST', `/orders/${failed.id}/refund/retry`, { token: await token('produtor') });
    expect(retry.status === 202, `reprocessamento recusado: ${retry.status}`);
    const fresh = await token('comprador');
    const done = await until('pedido ser reembolsado depois do reprocessamento', async () => {
      const current = await order(fresh, failed.id);
      return current.status === 'REFUNDED' ? current : null;
    }, { timeoutMs: 120_000 });
    step(`produtor reprocessou: pedido REFUNDED, R$ ${(done.refundedCents / 100).toFixed(2)} devolvidos`);
  },

  async 'pedidos-fora'() {
    const buyer = await token('comprador');
    const gate = await token('gate');
    const target = await tonightShow();
    const created = await place(buyer, target);
    const confirmed = await settled(buyer, created.id);
    expect(confirmed.status === 'CONFIRMED', 'compra não confirmou');
    await sleep(3_000); // a cópia local da portaria recebe o TicketsIssued pelo Kafka
    step('order-service parado');
    compose('stop order-service');
    try {
      const down = await api('GET', `/orders/${created.id}`, { token: buyer });
      expect(down.status >= 500, `o order-service deveria estar fora, respondeu ${down.status}`);
      step(`"Meus ingressos" fora do ar (${down.status}), mas na portaria:`);
      const first = await scan(gate, target.show.id, confirmed.tickets[0].code);
      const second = await scan(gate, target.show.id, confirmed.tickets[0].code, 'Portão Caos 2');
      expect(first.result === 'ACCEPTED', `a primeira leitura deveria entrar: ${JSON.stringify(first)}`);
      expect(second.result === 'ALREADY_USED', `a segunda deveria ser barrada: ${JSON.stringify(second)}`);
      step(`1ª leitura ${first.result}, 2ª ${second.result}: a portaria valida com a cópia local`);
    } finally {
      compose('start order-service');
    }
    await until('order-service de volta', async () => (await api('GET', `/orders/${created.id}`, { token: buyer })).status === 200, {
      timeoutMs: 120_000,
      intervalMs: 2_000,
    });
    await until('o pedido mostrar o ingresso usado', async () => (await order(buyer, created.id)).tickets[0].status === 'USED');
    step('de volta, o order-service leu o TicketCheckedIn: o ingresso aparece como usado');
  },

  async 'portaria-sem-consumir'() {
    const buyer = await token('comprador');
    const gate = await token('gate');
    const target = await tonightShow();
    step('checkin-service parado (consumidor de order.events)');
    compose('stop checkin-service');
    const tickets = [];
    try {
      const orders = [];
      for (let i = 0; i < 3; i++) orders.push(await place(buyer, target));
      for (const created of orders) {
        const confirmed = await settled(buyer, created.id);
        expect(confirmed.status === 'CONFIRMED', 'compra não confirmou');
        tickets.push(confirmed.tickets[0]);
      }
      const lag = await until('o lag do checkin-service subir', () =>
        prometheus('max(kafka_consumer_group_lag_sum_ratio{group="checkin-service",topic="order.events"})').then((value) => (value > 0 ? value : null)),
      { timeoutMs: 90_000, intervalMs: 5_000 });
      step(`3 compras confirmadas; lag do checkin-service em order.events: ${lag}`);
    } finally {
      compose('start checkin-service');
    }
    await until('o lag voltar a zero', () =>
      prometheus('max(kafka_consumer_group_lag_sum_ratio{group="checkin-service",topic="order.events"})').then((value) => value === 0),
    { timeoutMs: 120_000, intervalMs: 5_000 });
    step('checkin-service de volta: lag zerado');
    for (const ticket of tickets) {
      const first = await until('a portaria conhecer o ingresso', async () => {
        const result = await scan(gate, target.show.id, ticket.code);
        return result.result === 'UNKNOWN_TICKET' ? null : result;
      }, { timeoutMs: 60_000, intervalMs: 2_000 });
      expect(first.result === 'ACCEPTED', `ingresso deveria entrar: ${JSON.stringify(first)}`);
      expect((await scan(gate, target.show.id, ticket.code)).result === 'ALREADY_USED', 'segunda leitura deveria ser barrada');
    }
    const ids = tickets.map((ticket) => `'${ticket.id}'`).join(',');
    const copies = Number(sql('checkin', `SELECT count(*) FROM valid_tickets WHERE ticket_id IN (${ids})`));
    const entries = Number(sql('checkin', `SELECT count(*) FROM checkins WHERE ticket_id IN (${ids})`));
    expect(copies === 3 && entries === 3, `esperava 3 cópias e 3 entradas, achei ${copies} e ${entries}`);
    step('os 3 ingressos chegaram à portaria sem duplicar: 3 cópias, 3 entradas, as segundas leituras barradas');
  },

  async 'redis-core-reiniciado'() {
    step('abertura de vendas com k6 (300 VUs por 40 s); redis-core reiniciado aos 35 s');
    const k6 = spawn('sh', ['-c', `${COMPOSE} run --rm -e VUS=300 -e DURATION=40s k6 run --quiet reservation-opening.js`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    k6.stdout.on('data', (chunk) => (output += chunk));
    k6.stderr.on('data', (chunk) => (output += chunk));
    const finished = new Promise((resolve) => k6.on('exit', resolve));
    await sleep(35_000);
    compose('restart redis-core');
    step('redis-core reiniciado (o AOF recarrega estoque, assentos e fila)');
    await finished;
    const summary = output.split('\n').filter((line) => /lotou_(reservations|tickets|reserve_duration|seat)/.test(line));
    summary.forEach((line) => step(line.trim()));
    step('esperando a projeção do stream chegar ao Postgres');
    await sleep(15_000);
    const result = invariants();
    for (const { name, count } of result) expect(count === 0, `invariante quebrada: ${name} (${count})`);
    step('invariantes conferidas no Postgres: zero violações');
  },

  async 'postgres-lento'() {
    const target = await farShow();
    const since = Date.now();
    step('Toxiproxy entre o order-service e o Postgres, com 500 ms de latência, por 4 minutos');
    compose('--profile chaos up -d --wait toxiproxy');
    await fetch(`${TOXIPROXY}/proxies/postgres-orders`, { method: 'DELETE' });
    await fetch(`${TOXIPROXY}/proxies`, {
      method: 'POST',
      body: JSON.stringify({ name: 'postgres-orders', listen: '0.0.0.0:15432', upstream: 'postgres:5432' }),
    });
    recreate('order-service', { ORDERS_DATABASE_URL: 'jdbc:postgresql://toxiproxy:15432/orders' });
    await fetch(`${TOXIPROXY}/proxies/postgres-orders/toxics`, {
      method: 'POST',
      body: JSON.stringify({ name: 'latencia', type: 'latency', stream: 'downstream', attributes: { latency: 500, jitter: 50 } }),
    });
    const timings = [];
    let errors = 0;
    try {
      // Oito compradores ao mesmo tempo (o gateway limita cada usuário; o token é renovado a cada volta).
      const started = Date.now();
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (Date.now() - started < 4 * 60_000) {
          const buyer = await token('comprador');
          const reservation = await api('POST', '/reservations', {
            token: buyer,
            body: { showId: target.show.id, sectorId: target.sector.id, quantity: 1, cpf: cpf() },
          });
          if (reservation.status !== 201) {
            await sleep(500);
            continue;
          }
          const t0 = Date.now();
          const created = await api('POST', '/orders', { token: buyer, body: { reservationId: reservation.body.id } });
          timings.push(Date.now() - t0);
          if (created.status >= 500) errors++;
        }
      }));
      timings.sort((a, b) => a - b);
      const p50 = timings[Math.floor(timings.length / 2)];
      const p99 = timings[Math.floor(timings.length * 0.99)];
      step(`${timings.length} pedidos em 4 minutos: p50 ${p50} ms, p99 ${p99} ms, ${errors} com erro 5xx`);
      // O trace lento fica no Tempo (tail sampling guarda tudo acima de 500 ms): o span mais longo é o do banco.
      const now = Math.floor(Date.now() / 1000);
      const search = await (await fetch(
        `${GRAFANA}/api/datasources/proxy/uid/tempo/api/search?tags=${encodeURIComponent('service.name=order-service')}&minDuration=2s&limit=1&start=${now - 600}&end=${now}`,
      )).json();
      const trace = search.traces?.[0];
      expect(trace, 'nenhum trace lento do order-service no Tempo');
      const detail = await (await fetch(`${GRAFANA}/api/datasources/proxy/uid/tempo/api/traces/${trace.traceID}`)).json();
      const spans = detail.batches.flatMap((batch) => batch.scopeSpans.flatMap((scope) => scope.spans));
      const database = spans.filter((span) => span.attributes?.some((attribute) => attribute.key === 'db.system.name' || attribute.key === 'db.system'));
      const dbTime = database.reduce((total, span) => total + (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1e6, 0);
      step(`trace ${trace.traceID}: ${trace.durationMs} ms, dos quais ${Math.round(dbTime)} ms em ${database.length} consultas ao Postgres`);
      expect(dbTime > trace.durationMs * 0.5, 'o trace deveria apontar o Postgres como gargalo');
      const mail = await alertMail('Checkout lento: orçamento de latência queimando rápido', since, 6 * 60_000);
      step(`alerta de burn rate de latência chegou ao Mailpit às ${new Date(mail.Created).toLocaleTimeString('pt-BR')}`);
    } finally {
      await fetch(`${TOXIPROXY}/proxies/postgres-orders/toxics/latencia`, { method: 'DELETE' }).catch(() => {});
      recreate('order-service');
      compose('--profile chaos stop toxiproxy');
    }
  },

  async 'mensagem-malformada'() {
    const buyer = await token('comprador');
    const gate = await token('gate');
    const since = Date.now();
    const dltBefore = (await prometheus('sum(kafka_partition_current_offset_ratio{topic="order.events.dlt"})')) ?? 0;
    step('publicando "isto não é JSON" em order.events');
    execSync(
      `${COMPOSE} exec -T kafka /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server kafka:9092 --topic order.events`,
      { input: 'isto não é JSON\n', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const dltAfter = await until('a mensagem chegar à DLT', () =>
      prometheus('sum(kafka_partition_current_offset_ratio{topic="order.events.dlt"})').then((value) => (value > dltBefore ? value : null)),
    { timeoutMs: 120_000, intervalMs: 5_000 });
    step(`order.events.dlt: ${dltBefore} -> ${dltAfter} mensagens (uma por consumidor que a leu)`);
    const target = await tonightShow();
    const created = await place(buyer, target);
    const confirmed = await settled(buyer, created.id);
    expect(confirmed.status === 'CONFIRMED', 'a compra seguinte não confirmou');
    const scanned = await until('a portaria conhecer o ingresso seguinte', async () => {
      const result = await scan(gate, target.show.id, confirmed.tickets[0].code);
      return result.result === 'UNKNOWN_TICKET' ? null : result;
    }, { timeoutMs: 60_000, intervalMs: 2_000 });
    expect(scanned.result === 'ACCEPTED', `ingresso seguinte deveria entrar: ${JSON.stringify(scanned)}`);
    step('os consumidores seguiram: a compra seguinte confirmou e o ingresso entrou na portaria');
    const mail = await alertMail('Mensagem nova numa DLT do Kafka', since);
    step(`alerta "Mensagem nova numa DLT do Kafka" chegou ao Mailpit às ${new Date(mail.Created).toLocaleTimeString('pt-BR')}`);
  },
};

const requested = process.argv[2] ?? 'todos';
const names = requested === 'todos' ? Object.keys(experiments) : [requested];
for (const name of names) {
  if (!experiments[name]) {
    console.error(`Experimento desconhecido: ${name}. Opções: ${Object.keys(experiments).join(', ')}, todos`);
    process.exit(2);
  }
}
let failed = 0;
for (const name of names) {
  console.log(`\n== ${name}`);
  const started = Date.now();
  try {
    await experiments[name]();
    console.log(`OK (${Math.round((Date.now() - started) / 1000)} s)`);
  } catch (error) {
    failed++;
    console.log(`FALHOU: ${error.message}`);
    if (!(error instanceof Failure)) console.log(error.stack);
  }
}
process.exit(failed ? 1 : 0);
