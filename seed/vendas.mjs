/**
 * Atividade de demonstração: compras, cupons, cancelamentos e entradas na portaria,
 * feitas pela API como a compradora e a portaria de demonstração, para o painel do
 * produtor, o financeiro e os dashboards do Grafana não começarem vazios.
 *
 * - Em cada show comum com vendas abertas: VENDAS_POR_SHOW pedidos (padrão 6), de 1 a
 *   4 ingressos de pista ou 1 a 2 cadeiras; um em cada três com o cupom de lançamento.
 * - Um pedido em cada seis é cancelado, com reembolso (quando a política deixa).
 * - No show de hoje, metade dos ingressos passa pela portaria, em dois portões.
 *
 * Tudo passa pela saga, como uma compra na loja: os e-mails chegam ao Mailpit.
 * Uso: `make seed-vendas` (depois do `make seed`). Pode rodar mais de uma vez: cada
 * rodada soma mais vendas.
 */
import { randomInt, randomUUID } from 'node:crypto';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';
const CLIENT_SECRET = process.env.SEED_CLIENT_SECRET ?? 'lotou-seed-dev-secret';
const PER_SHOW = Number(process.env.VENDAS_POR_SHOW ?? 6);
const API = `${GATEWAY_URL}/api/v1`;
const COUPONS = {
  'Turnê Horizonte': 'HORIZONTE15',
  'Vinte Anos de Estrada': 'ESTRADA20',
  'Baile da Maré Cheia': 'MARE10',
  'Inverno Elétrico': 'INVERNO25',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function login(username) {
  const response = await fetch(`${KEYCLOAK_URL}/realms/lotou/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'lotou-seed',
      client_secret: CLIENT_SECRET,
      username,
      password: 'lotou123',
    }),
  });
  if (!response.ok) throw new Error(`Keycloak recusou ${username}: ${response.status}`);
  return (await response.json()).access_token;
}

async function api(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
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

/** O que reservar num setor: quantidade na pista, cadeiras livres lado a lado no resto. */
async function choice(show, sector) {
  if (sector.kind === 'GENERAL_ADMISSION') return { quantity: randomInt(1, 5) };
  const map = await (await fetch(`${API}/availability/${show.id}/sectors/${sector.id}/seats`)).json();
  const free = map.seats.filter((seat) => seat.available).map((seat) => seat.label);
  if (!free.length) return null;
  const start = randomInt(free.length);
  return { seats: free.slice(start, start + randomInt(1, 3)) };
}

async function buy(buyer, show, sector, couponCode) {
  const pick = await choice(show, sector);
  if (!pick) return null;
  const reservation = await api(buyer, 'POST', '/reservations', { showId: show.id, sectorId: sector.id, cpf: cpf(), ...pick });
  if (reservation.status !== 201) return null;
  const order = await api(buyer, 'POST', '/orders', { reservationId: reservation.body.id, ...(couponCode && { couponCode }) });
  // O gateway aceita 2 pedidos por segundo por usuário.
  await sleep(600);
  return order.status === 201 ? order.body : null;
}

async function settle(buyer, id) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { body } = await api(buyer, 'GET', `/orders/${id}`);
    if (body?.status !== 'PENDING') return body;
    await sleep(500);
  }
  return null;
}

console.log(`Vendas de demonstração em ${GATEWAY_URL}`);
const buyer = await login('comprador');
const gate = await login('portaria');
const { body: page } = await api(null, 'GET', '/shows?limit=50');
const now = Date.now();
const tonight = [];
let total = 0;
for (const show of page.items.filter((item) => !item.highDemand)) {
  const availability = await (await fetch(`${API}/availability/${show.id}`)).json();
  const sectors = (availability.sectors ?? []).filter((sector) => sector.sale === 'ON_SALE' && sector.available > 0);
  if (!sectors.length) continue;
  const orders = [];
  for (let i = 0; i < PER_SHOW; i++) {
    const coupon = i % 3 === 0 ? COUPONS[show.title] : undefined;
    const created = await buy(buyer, show, sectors[i % sectors.length], coupon);
    if (created) orders.push(created);
  }
  const confirmed = [];
  for (const created of orders) {
    const settled = await settle(buyer, created.id);
    if (settled?.status === 'CONFIRMED') confirmed.push(settled);
  }
  let cancelled = 0;
  for (const order of confirmed.filter((_, i) => i % 6 === 5)) {
    if (order.cancellation?.allowed && (await api(buyer, 'POST', `/orders/${order.id}/cancel`)).status === 202) cancelled++;
  }
  total += confirmed.length;
  console.log(`  ${show.artist}: ${confirmed.length} pedidos confirmados, ${cancelled} cancelados`);
  const startsIn = Date.parse(show.startsAt) - now;
  if (startsIn > 0 && startsIn < 26 * 3_600_000) tonight.push({ show, confirmed });
}

for (const { show, confirmed } of tonight) {
  await sleep(3_000); // a portaria recebe os ingressos pelo Kafka
  const tickets = confirmed.flatMap((order) => order.tickets);
  let entered = 0;
  for (const [i, ticket] of tickets.entries()) {
    if (i % 2) continue;
    const gateName = i % 4 === 0 ? 'Portão A' : 'Portão B';
    const { body } = await api(gate, 'POST', '/checkins', { showId: show.id, gate: gateName, code: ticket.code });
    if (body?.result === 'ACCEPTED') entered++;
  }
  console.log(`  ${show.artist}: ${entered} entradas na portaria`);
}
console.log(`Pronto: ${total} pedidos confirmados. Veja o painel em http://localhost:4200/painel e o Grafana em http://localhost:3000`);
