// Abertura de vendas: muitos compradores ao mesmo tempo disputando a pista e as cadeiras de um show.
//
// O que prova: nenhuma venda além da capacidade e nenhuma cadeira duas vezes (conferido no banco
// por check-invariants.sql), e a latência da reserva no motor configurado no inventory
// (RESERVATION_ENGINE=redis ou postgres). As reservas vão direto ao inventory-service, sem o
// gateway, para medir o motor de reserva e não o rate limit (ADR 3).
//
// Variáveis: VUS (padrão 2000), PISTA (2000), ROWS (10), SEATS_PER_ROW (50), DURATION (60s).
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { cpf, createShowOnSale, INVENTORY_URL, tokens, uuid, WARMUP, warmupReservation, rowLabel } from './lib/lotou.js';

const VUS = Number(__ENV.VUS || 2000);
const DURATION = __ENV.DURATION || '60s';

const reserved = new Counter('lotou_reservations_ok');
const ticketsReserved = new Counter('lotou_tickets_reserved');
const refused = new Counter('lotou_reservations_refused');
const seatConflicts = new Counter('lotou_seat_conflicts');
const unexpected = new Counter('lotou_reservations_unexpected');
const reserveLatency = new Trend('lotou_reserve_duration', true);

export const options = {
  setupTimeout: '120s',
  scenarios: {
    warmup: WARMUP,
    opening: {
      startTime: '25s',
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    // Meta do documento: reserva com p99 abaixo de 50 ms. Fica registrado, não derruba o teste.
    lotou_reserve_duration: [{ threshold: 'p(99)<50', abortOnFail: false }],
    lotou_reservations_unexpected: ['count==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const { producer, buyer } = tokens();
  const show = createShowOnSale(producer, {
    pista: Number(__ENV.PISTA || 2000),
    rows: Number(__ENV.ROWS || 10),
    seatsPerRow: Number(__ENV.SEATS_PER_ROW || 50),
    name: 'abertura',
  });
  // Show do aquecimento: grande o bastante para não esgotar em 20 s.
  const warmup = createShowOnSale(producer, { pista: 200_000, rows: 0, seatsPerRow: 0, name: 'aquecimento' });
  console.log(`Show de teste: ${show.showId}`);
  return { ...show, warmup, token: buyer };
}

export function warmup(data) {
  warmupReservation(data);
}

/** De 1 a 4 cadeiras vizinhas, numa fileira aleatória. */
function randomSeats(rows, perRow) {
  const count = 1 + Math.floor(Math.random() * 4);
  const row = rowLabel(Math.floor(Math.random() * rows));
  const first = 1 + Math.floor(Math.random() * (perRow - count + 1));
  return Array.from({ length: count }, (_, i) => `${row}-${first + i}`);
}

export default function (data) {
  // 4 em cada 5 compradores vão para a pista; o resto escolhe cadeiras.
  const pista = Math.random() < 0.8;
  const selection = pista
    ? { sectorId: data.pistaId, quantity: 1 + Math.floor(Math.random() * 4) }
    : { sectorId: data.seatsId, seats: randomSeats(data.rows, data.seatsPerRow) };
  const response = http.post(
    `${INVENTORY_URL}/v1/reservations`,
    JSON.stringify({ showId: data.showId, cpf: cpf(), ...selection }),
    {
      headers: {
        Authorization: `Bearer ${data.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uuid(),
      },
      tags: { name: 'reserve' },
    },
  );
  reserveLatency.add(response.timings.duration);

  if (response.status === 201) {
    reserved.add(1);
    ticketsReserved.add(response.json('quantity'));
    return;
  }
  const type = response.status < 500 ? (response.json('type') || '') : '';
  const expected = ['sold-out', 'insufficient-stock', 'seat-unavailable'].some((slug) => type.endsWith(slug));
  check(response, { 'recusa esperada (esgotado ou cadeira ocupada)': () => expected });
  if (type.endsWith('seat-unavailable')) seatConflicts.add(1);
  if (expected) {
    refused.add(1);
  } else {
    unexpected.add(1, { status: String(response.status), type });
  }
}
