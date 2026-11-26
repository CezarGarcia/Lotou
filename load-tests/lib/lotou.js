// Funções comuns aos testes de carga: tokens, criação do show de teste e CPFs.
import http from 'k6/http';
import { sleep } from 'k6';

export const KEYCLOAK_URL = __ENV.KEYCLOAK_URL || 'http://keycloak:8080';
export const EVENT_SERVICE_URL = __ENV.EVENT_SERVICE_URL || 'http://event-service:3000';
export const INVENTORY_URL = __ENV.INVENTORY_URL || 'http://inventory-service:8082';
export const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://api-gateway:8080';

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

function post(url, token, body) {
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
export function createShowOnSale(producerToken, { pista, rows, seatsPerRow, highDemand = false, name }) {
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
  const startsAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const show = post(`${EVENT_SERVICE_URL}/v1/shows`, producerToken, {
    title: `Teste de carga: ${name}`,
    artist: 'Banda de Carga',
    startsAt,
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
