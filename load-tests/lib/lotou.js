// Funções comuns aos testes de carga: tokens, criação do show de teste e CPFs.
import http from 'k6/http';
import { sleep } from 'k6';

export const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || 'http://keycloak:8080';
export const EVENT_SERVICE_URL = __ENV.EVENT_SERVICE_URL || 'http://event-service:3000';
export const INVENTORY_URL = __ENV.INVENTORY_URL || 'http://inventory-service:8082';
export const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://api-gateway:8080';
export const ORDER_URL = __ENV.ORDER_URL || 'http://order-service:8083';
export const CHECKIN_URL = __ENV.CHECKIN_URL || 'http://checkin-service:3003';
// Painéis de administração, lidos pelos cenários que medem filas e consumidores.
export const RABBITMQ_API_URL = __ENV.RABBITMQ_API_URL || 'http://lotou:lotou@rabbitmq:15672/api';
export const KAFKA_UI_URL = __ENV.KAFKA_UI_URL || 'http://kafka-ui:8080';

/** Token de uma conta de serviço do realm (client credentials). */
export function clientToken(clientId, secret) {
  const response = http.post(`${KEYCLOAK_URL}/realms/lotou/protocol/openid-connect/token`, {
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: secret,
  });
  if (response.status !== 200) {
    throw new Error(`Keycloak recusou ${clientId}: ${response.status} ${response.body}`);
  }
  return response.json('access_token');
}

/** Produtor (conta de serviço do seed) e comprador (conta de serviço do smoke). */
export function tokens() {
  return {
    producer: clientToken('lotou-seed', __ENV.SEED_CLIENT_SECRET || 'lotou-seed-dev-secret'),
    buyer: clientToken('lotou-smoke', __ENV.SMOKE_CLIENT_SECRET || 'lotou-smoke-dev-secret'),
  };
}

/**
 * Token do comprador (conta de serviço do smoke, com os papéis de comprador e de portaria),
 * guardado por VU e renovado antes de vencer: o token dura 5 minutos, menos que os cenários longos.
 */
let buyer = null;
export function buyerToken() {
  if (!buyer || Date.now() > buyer.renewAt) {
    buyer = {
      token: clientToken('lotou-smoke', __ENV.SMOKE_CLIENT_SECRET || 'lotou-smoke-dev-secret'),
      renewAt: Date.now() + 240_000,
    };
  }
  return buyer.token;
}

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Um CPF válido aleatório: cada VU usa o seu, para o limite por CPF não interferir. */
export function cpf() {
  const digits = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (const length of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += digits[i] * (length + 1 - i);
    digits.push(((sum * 10) % 11) % 10);
  }
  return digits.join('');
}

export function post(url, token, body) {
  const response = http.post(url, JSON.stringify(body), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': uuid(),
    },
  });
  if (response.status >= 300) {
    throw new Error(`POST ${url} -> ${response.status} ${response.body}`);
  }
  return response.json();
}

/**
 * Cria e publica um show com um setor de pista e um de cadeira numerada, com as vendas abertas na
 * publicação, e espera o inventory abrir as vendas. Devolve os IDs para os VUs.
 */
export function createShowOnSale(
  producerToken,
  { pista, rows, seatsPerRow, highDemand = false, name, startsAt, doorsOpenAt = null },
) {
  const sectors = [];
  if (pista > 0) sectors.push({ name: 'Pista', kind: 'GENERAL_ADMISSION', capacity: pista });
  if (rows > 0) {
    sectors.push({
      name: 'Cadeira',
      kind: 'RESERVED_SEATING',
      capacity: rows * seatsPerRow,
      rows: Array.from({ length: rows }, (_, i) => ({ label: rowLabel(i), seatCount: seatsPerRow })),
    });
  }
  const venue = post(`${EVENT_SERVICE_URL}/v1/venues`, producerToken, {
    name: `Arena de carga ${name} ${uuid().slice(0, 8)}`,
    address: { city: 'São Paulo', state: 'SP' },
    timezone: 'America/Sao_Paulo',
    sectors,
  });
  const show = post(`${EVENT_SERVICE_URL}/v1/shows`, producerToken, {
    title: `Teste de carga: ${name}`,
    artist: 'Banda de Carga',
    startsAt: startsAt || new Date(Date.now() + 30 * 86_400_000).toISOString(),
    doorsOpenAt,
    highDemand,
    venueId: venue.id,
    sectors: venue.sectors.map((sector) => ({
      sectorId: sector.id,
      lots: [{ name: 'Lote único', priceCents: 10_000, quantity: sector.capacity }],
    })),
  });
  post(`${EVENT_SERVICE_URL}/v1/shows/${show.id}/publish`, producerToken, {});

  // O inventory lê o catálogo a cada 2 s e abre as vendas no ciclo seguinte.
  for (let attempt = 0; attempt < 60; attempt++) {
    const availability = http.get(`${INVENTORY_URL}/v1/availability/${show.id}`);
    if (availability.status === 200 && availability.json('sectors').every((s) => s.sale === 'ON_SALE')) {
      const ids = Object.fromEntries(venue.sectors.map((s) => [s.kind, s.id]));
      return { showId: show.id, pistaId: ids.GENERAL_ADMISSION, seatsId: ids.RESERVED_SEATING, rows, seatsPerRow };
    }
    sleep(1);
  }
  throw new Error('O inventory não abriu as vendas do show de teste');
}

/**
 * Aquecimento: reservas num show à parte, antes da medição. Trocar o motor de reserva recria o
 * container do inventory, e uma JVM recém-iniciada ainda não compilou o caminho quente.
 */
export const WARMUP = {
  executor: 'constant-vus',
  vus: 50,
  duration: '20s',
  exec: 'warmup',
  tags: { phase: 'warmup' },
};

export function warmupReservation(data) {
  http.post(
    `${INVENTORY_URL}/v1/reservations`,
    JSON.stringify({ showId: data.warmup.showId, sectorId: data.warmup.pistaId, quantity: 1, cpf: cpf() }),
    {
      headers: {
        Authorization: `Bearer ${data.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uuid(),
      },
      tags: { name: 'warmup' },
    },
  );
}

export function rowLabel(index) {
  let label = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  }
  return label;
}

function jsonHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': uuid(),
  };
}

/** Reserva ingressos de pista direto no inventory, com um CPF novo. Devolve a resposta do k6. */
export function reservePista(token, showId, sectorId, quantity) {
  return http.post(
    `${INVENTORY_URL}/v1/reservations`,
    JSON.stringify({ showId, sectorId, quantity, cpf: cpf() }),
    { headers: jsonHeaders(token), tags: { name: 'reserve' } },
  );
}

/** Cria o pedido da reserva direto no order-service (sem o rate limit do gateway). */
export function createOrder(token, reservationId, couponCode) {
  return http.post(
    `${ORDER_URL}/v1/orders`,
    JSON.stringify({ reservationId, ...(couponCode && { couponCode }) }),
    { headers: jsonHeaders(token), tags: { name: 'create-order' } },
  );
}

/** Reserva e cria o pedido; devolve o pedido criado ou `null`, com a resposta que falhou. */
export function buyPista(token, showId, sectorId, quantity, couponCode) {
  const reservation = reservePista(token, showId, sectorId, quantity);
  if (reservation.status !== 201) return { order: null, response: reservation };
  const order = createOrder(token, reservation.json('id'), couponCode);
  return { order: order.status === 201 ? order.json() : null, response: order };
}

/**
 * Todos os pedidos do comprador do token criados desde `since`, de um show, pela listagem
 * "Meus pedidos" (do mais novo ao mais antigo, paginada por cursor).
 */
export function ordersOfShow(token, showId, since) {
  const found = [];
  let cursor = null;
  do {
    const response = http.get(`${ORDER_URL}/v1/orders?limit=100${cursor ? `&cursor=${cursor}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
      tags: { name: 'list-orders' },
    });
    if (response.status !== 200) throw new Error(`GET /v1/orders -> ${response.status} ${response.body}`);
    const page = response.json();
    for (const order of page.items) {
      if (Date.parse(order.createdAt) < since) return found;
      if (order.showId === showId) found.push(order);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return found;
}

/**
 * Espera os pedidos saírem de PENDING (a saga anda pelo Kafka). Devolve a contagem por status.
 */
export function waitOrdersSettled(token, showId, since, { timeoutSeconds = 600 } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const orders = ordersOfShow(token, showId, since);
    const byStatus = {};
    for (const order of orders) byStatus[order.status] = (byStatus[order.status] || 0) + 1;
    if (!byStatus.PENDING || Date.now() > deadline) return { orders, byStatus };
    sleep(2);
  }
}

/** Uma fila do RabbitMQ pela API de management: mensagens prontas, em entrega e consumidores. */
export function rabbitQueue(name) {
  const response = http.get(`${RABBITMQ_API_URL}/queues/%2F/${encodeURIComponent(name)}`, {
    tags: { name: 'rabbitmq-api' },
  });
  if (response.status !== 200) throw new Error(`RabbitMQ: fila ${name} -> ${response.status}`);
  const queue = response.json();
  return {
    messages: queue.messages || 0,
    ready: queue.messages_ready || 0,
    unacked: queue.messages_unacknowledged || 0,
    consumers: queue.consumers || 0,
    acked: (queue.message_stats && queue.message_stats.ack) || 0,
  };
}

/**
 * Lag do consumer group mais novo com o prefixo (as gerações do analytics, ADR 30), pelo Kafka UI:
 * quantas mensagens dos tópicos ainda não foram confirmadas pelo grupo.
 */
export function consumerLag(prefix) {
  const response = http.get(
    `${KAFKA_UI_URL}/api/clusters/lotou/consumer-groups/paged?perPage=100&search=${encodeURIComponent(prefix)}`,
    { tags: { name: 'kafka-ui-api' } },
  );
  if (response.status !== 200) throw new Error(`Kafka UI -> ${response.status} ${response.body}`);
  const generation = (group) => Number(group.groupId.slice(prefix.length)) || 0;
  const groups = response.json('consumerGroups').filter((group) => group.groupId.startsWith(prefix));
  if (groups.length === 0) throw new Error(`Nenhum consumer group com o prefixo ${prefix}`);
  const latest = groups.reduce((a, b) => (generation(b) > generation(a) ? b : a));
  return { group: latest.groupId, lag: latest.consumerLag || 0, members: latest.members, state: latest.state };
}
