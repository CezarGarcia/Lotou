/**
 * Seed do Lotou: cria locais e shows fictícios pela API, do mesmo jeito que o
 * painel do produtor fará.
 *
 * - Autentica no Keycloak como a conta de serviço `lotou-seed` (client
 *   credentials), que tem o papel de produtor.
 * - Cria cada local e cada show com `Idempotency-Key`, e publica os shows.
 * - Cria o cupom de lançamento de cada show (o order-service precisa já ter
 *   recebido o show pelo Kafka: espera um pouco se ainda não recebeu).
 * - Pode rodar várias vezes: o que já existe é reaproveitado, não duplicado.
 *
 * Uso: `make seed` na raiz (roda dentro do Compose), ou direto com Node 22+:
 *   node seed/seed.mjs
 */
import { shows, venues } from './data.mjs';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const CLIENT_ID = process.env.SEED_CLIENT_ID ?? 'lotou-seed';
const CLIENT_SECRET = process.env.SEED_CLIENT_SECRET ?? 'lotou-seed-dev-secret';
// Os shows são criados em nome do produtor de demonstração, para aparecerem no painel dele.
const PRODUCER_USERNAME = process.env.SEED_PRODUCER_USERNAME ?? 'produtor';
const PRODUCER_PASSWORD = process.env.SEED_PRODUCER_PASSWORD ?? 'lotou123';

const API = `${GATEWAY_URL}/api/v1`;
const today = new Date().toISOString().slice(0, 10);
const slug = (text) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');

async function waitForGateway() {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const response = await fetch(`${GATEWAY_URL}/actuator/health/readiness`);
      if (response.ok) return;
    } catch {
      // ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`O gateway não respondeu em ${GATEWAY_URL}`);
}

async function getToken() {
  const response = await fetch(
    `${KEYCLOAK_URL}/realms/lotou/protocol/openid-connect/token`,
    {
      method: 'POST',
      // Fluxo de senha, liberado só neste cliente de desenvolvimento: o seed age como o produtor
      // de demonstração, e o painel dele mostra os shows criados aqui.
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        username: PRODUCER_USERNAME,
        password: PRODUCER_PASSWORD,
        scope: 'openid',
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Keycloak recusou o seed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()).access_token;
}

/** Chama a API e devolve o JSON; erro vira exceção com o Problem Details. */
async function api(token, method, path, { body, idempotencyKey } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && { 'Content-Type': 'application/json' }),
      ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
    },
    body: body && JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    const errors = (payload.errors ?? [])
      .map((error) => `\n    ${error.field}: ${error.message}`)
      .join('');
    throw new Error(
      `${method} ${path} -> ${response.status} ${payload.title}: ${payload.detail ?? ''}${errors}`,
    );
  }
  return payload;
}

/** Lê todas as páginas de uma listagem paginada por cursor. */
async function listAll(token, path) {
  const items = [];
  let cursor = null;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const page = await api(
      token,
      'GET',
      `${path}${separator}limit=100${cursor ? `&cursor=${cursor}` : ''}`,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function seedVenues(token) {
  const existing = new Map(
    (await listAll(token, '/venues')).map((venue) => [venue.name, venue]),
  );
  const byName = new Map();
  for (const venue of venues) {
    let saved = existing.get(venue.name);
    if (saved) {
      console.log(`  = ${venue.name} (já existe)`);
    } else {
      saved = await api(token, 'POST', '/venues', {
        body: venue,
        idempotencyKey: `seed-venue-${slug(venue.name)}`,
      });
      console.log(`  + ${venue.name}, ${venue.address.city}/${venue.address.state}`);
    }
    byName.set(venue.name, saved);
  }
  return byName;
}

async function seedShows(token, venuesByName) {
  const published = new Map(
    (await listAll(token, '/shows')).map((show) => [`${show.artist}|${show.title}`, show]),
  );
  const withCoupons = [];
  for (const { venue: venueName, sectors, coupon, ...show } of shows) {
    const label = `${show.artist}: ${show.title}`;
    const existing = published.get(`${show.artist}|${show.title}`);
    if (existing) {
      console.log(`  = ${label} (já existe)`);
      if (coupon) withCoupons.push({ label, showId: existing.id, coupon, until: show.salesEndAt });
      continue;
    }

    const venue = venuesByName.get(venueName);
    const body = {
      ...show,
      venueId: venue.id,
      sectors: Object.entries(sectors).map(([sectorName, lots]) => ({
        sectorId: venue.sectors.find((sector) => sector.name === sectorName).id,
        lots,
      })),
    };
    // As datas do show dependem do dia: a chave também, para o corpo ser o
    // mesmo em toda repetição com a mesma chave.
    const created = await api(token, 'POST', '/shows', {
      body,
      idempotencyKey: `seed-show-${slug(label)}-${today}`,
    });
    const current = await api(token, 'GET', `/shows/${created.id}`);
    if (current.status === 'DRAFT') {
      await api(token, 'POST', `/shows/${created.id}/publish`);
    }
    console.log(`  + ${label} (${venueName})`);
    if (coupon) withCoupons.push({ label, showId: created.id, coupon, until: show.salesEndAt });
  }
  return withCoupons;
}

/** O cupom de lançamento de cada show, se o show ainda não tem um com o mesmo código. */
async function seedCoupons(token, withCoupons) {
  for (const { label, showId, coupon, until } of withCoupons) {
    let existing;
    for (let attempt = 1; ; attempt++) {
      try {
        existing = await listAll(token, `/coupons?showId=${showId}`);
        break;
      } catch (error) {
        // 404: o order-service ainda não recebeu o show pelo Kafka.
        if (!error.message.includes('-> 404') || attempt === 15) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    if (existing.some((saved) => saved.code === coupon.code)) {
      console.log(`  = ${coupon.code} (já existe)`);
      continue;
    }
    await api(token, 'POST', '/coupons', {
      body: { showId, ...coupon, validUntil: new Date(until).toISOString() },
      idempotencyKey: `seed-coupon-${showId}-${coupon.code}`,
    });
    console.log(`  + ${coupon.code} (${label})`);
  }
}

console.log(`Seed do Lotou em ${GATEWAY_URL}`);
await waitForGateway();
const token = await getToken();
console.log('Locais');
const venuesByName = await seedVenues(token);
console.log('Shows');
const withCoupons = await seedShows(token, venuesByName);
console.log('Cupons');
await seedCoupons(token, withCoupons);
console.log('Pronto. Abra a loja em http://localhost:4200');
