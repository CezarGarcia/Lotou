/**
 * Confere o ambiente no ar (depois de `make up` e `make seed`):
 *
 *   1. a loja responde e a busca devolve os shows do seed;
 *   2. uma compra de ponta a ponta funciona: reserva no inventory-service,
 *      pedido no order-service, ingresso emitido e estoque baixado;
 *   3. as duas requisições geram traces completos no Tempo: a busca até o
 *      MongoDB e a compra até o Postgres, atravessando os serviços.
 *
 * Uso: `make smoke` na raiz (roda dentro do Compose). O script compra um
 * ingresso de verdade a cada execução, como a conta de serviço `lotou-smoke`.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:4200';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://localhost:3000';
const CLIENT_ID = process.env.SMOKE_CLIENT_ID ?? 'lotou-smoke';
const CLIENT_SECRET = process.env.SMOKE_CLIENT_SECRET ?? 'lotou-smoke-dev-secret';

const API = `${WEB_URL}/api/v1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`FALHOU: ${message}`);
  process.exit(1);
}

/** Um `traceparent` novo, para achar depois o trace desta requisição. */
function newTrace() {
  const traceId = randomBytes(16).toString('hex');
  return { traceId, header: `00-${traceId}-${randomBytes(8).toString('hex')}-01` };
}

/** Um CPF válido aleatório (os dígitos verificadores são calculados). */
function randomCpf() {
  const digits = Array.from({ length: 9 }, () => randomInt(10));
  for (const length of [9, 10]) {
    const sum = digits.slice(0, length).reduce((total, digit, i) => total + digit * (length + 1 - i), 0);
    digits.push(((sum * 10) % 11) % 10);
  }
  return digits.join('');
}

async function api(method, path, { token, body, trace, idempotent } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
      ...(trace && { traceparent: trace.header }),
      ...(idempotent && { 'Idempotency-Key': randomUUID() }),
    },
    body: body && JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    fail(`${method} ${path} -> ${response.status} ${payload.title ?? ''}: ${payload.detail ?? ''}`);
  }
  return payload;
}

async function buyerToken() {
  const response = await fetch(`${KEYCLOAK_URL}/realms/lotou/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!response.ok) fail(`o Keycloak recusou o cliente ${CLIENT_ID}: ${response.status}`);
  return (await response.json()).access_token;
}

/** Espera o trace chegar ao Tempo com todos os serviços e bancos esperados. */
async function expectTrace({ traceId }, services, database) {
  let seen = { services: [], databases: [] };
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`${GRAFANA_URL}/api/datasources/proxy/uid/tempo/api/traces/${traceId}`);
    if (response.ok) {
      const batches = (await response.json()).batches ?? [];
      const attribute = (attributes, key) =>
        attributes?.find((item) => item.key === key)?.value?.stringValue;
      seen = {
        services: [...new Set(batches.map((batch) => attribute(batch.resource.attributes, 'service.name')))],
        databases: [
          ...new Set(
            batches
              .flatMap((batch) => batch.scopeSpans.flatMap((scope) => scope.spans))
              .map((span) => attribute(span.attributes, 'db.system.name') ?? attribute(span.attributes, 'db.system'))
              .filter(Boolean),
          ),
        ],
      };
      if (services.every((name) => seen.services.includes(name)) && seen.databases.includes(database)) {
        console.log(`   trace ${traceId}: ${seen.services.join(', ')} -> ${database}`);
        return;
      }
    }
    await sleep(2_000);
  }
  fail(
    `o trace ${traceId} não chegou completo ao Tempo ` +
      `(serviços: ${seen.services.join(', ') || 'nenhum'}; bancos: ${seen.databases.join(', ') || 'nenhum'})`,
  );
}

console.log(`1. Loja em ${WEB_URL}`);
const home = await fetch(`${WEB_URL}/`);
if (!home.ok || !(await home.text()).includes('<app-root>')) fail('a loja não respondeu');

const searchTrace = newTrace();
const { items: shows } = await api('GET', '/shows?limit=50', { trace: searchTrace });
if (shows.length < 3) fail(`esperava ao menos 3 shows, vieram ${shows.length}. Rodou 'make seed'?`);
console.log(`   ${shows.length} shows na busca`);

console.log('2. Compra de ponta a ponta');
// Um setor de pista com vendas abertas. Logo depois do seed, o inventory ainda
// pode estar lendo o catálogo e abrindo as vendas: espera um pouco.
let target;
for (let attempt = 0; attempt < 30 && !target; attempt++) {
  // Shows de alta demanda pedem a fila virtual; a compra direta usa um show comum.
  for (const show of shows.filter((item) => !item.highDemand)) {
    const response = await fetch(`${API}/availability/${show.id}`);
    if (!response.ok) continue;
    const sector = (await response.json()).sectors.find(
      (item) => item.kind === 'GENERAL_ADMISSION' && item.sale === 'ON_SALE' && item.available > 0,
    );
    if (sector) {
      target = { show, sector };
      break;
    }
  }
  if (!target) await sleep(2_000);
}
if (!target) fail('nenhum show com pista à venda. As vendas de algum show do seed já deveriam ter aberto.');
const { show, sector } = target;
console.log(`   ${show.artist}, ${sector.name}, ${sector.lot.name} a R$ ${(sector.lot.priceCents / 100).toFixed(2)}`);

const token = await buyerToken();
const purchaseTrace = newTrace();
const reservation = await api('POST', '/reservations', {
  token,
  idempotent: true,
  trace: purchaseTrace,
  body: { showId: show.id, sectorId: sector.id, quantity: 1, cpf: randomCpf() },
});
if (reservation.status !== 'HELD' || reservation.totalCents !== sector.lot.priceCents) {
  fail(`reserva inesperada: ${JSON.stringify(reservation)}`);
}
console.log(`   reserva ${reservation.id} segurada até ${reservation.expiresAt}`);

const orderTrace = newTrace();
const created = await api('POST', '/orders', {
  token,
  idempotent: true,
  trace: orderTrace,
  body: { reservationId: reservation.id },
});
if (created.status !== 'PENDING') fail(`o pedido deveria nascer PENDING: ${JSON.stringify(created)}`);
console.log(`   pedido ${created.id} criado; a saga segue pelo Kafka`);

// Pagamento, confirmação da reserva e emissão dos ingressos acontecem pela saga: acompanha o pedido.
let order = created;
for (let attempt = 0; attempt < 60 && order.status === 'PENDING'; attempt++) {
  await sleep(500);
  order = await api('GET', `/orders/${created.id}`, { token });
}
if (order.status !== 'CONFIRMED' || order.tickets.length !== 1 || order.tickets[0].status !== 'VALID') {
  fail(`o pedido não foi confirmado com um ingresso válido: ${JSON.stringify(order)}`);
}
console.log(`   pedido ${order.id} confirmado, ingresso ${order.tickets[0].id}`);

const after = (await api('GET', `/availability/${show.id}`)).sectors.find((item) => item.id === sector.id);
if (after.sale === 'ON_SALE' && after.available >= sector.available) {
  fail(`o estoque não baixou: tinha ${sector.available}, ficou ${after.available}`);
}
console.log(`   estoque do lote: ${sector.available} -> ${after.available}`);

console.log('3. Traces no Tempo');
await expectTrace(searchTrace, ['api-gateway', 'event-service'], 'mongodb');
// A reserva acontece num script Lua no redis-core (motor padrão): o trace termina no Redis.
await expectTrace(purchaseTrace, ['api-gateway', 'inventory-service'], 'redis');
// O trace do pedido atravessa o Kafka: do gateway ao order-service, dele ao payment-mock e ao inventory.
await expectTrace(orderTrace, ['api-gateway', 'order-service', 'payment-mock', 'inventory-service'], 'postgresql');

console.log(`OK. Veja os traces em http://localhost:3000/explore (Tempo), por exemplo ${orderTrace.traceId}`);
