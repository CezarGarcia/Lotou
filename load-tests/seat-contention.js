// Disputa por assento: muitos compradores tentando as mesmas poucas cadeiras.
//
// O que prova: nenhuma cadeira é segurada por duas reservas (conferido no banco por
// check-invariants.sql) e os conflitos aparecem em seat_hold_conflicts_total.
//
// Variáveis: VUS (padrão 1000), SEATS (50, numa fileira só), ITERATIONS (VUS: uma tentativa cada).
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { cpf, createShowOnSale, INVENTORY_URL, tokens, uuid, WARMUP, warmupReservation } from './lib/lotou.js';

const VUS = Number(__ENV.VUS || 1000);
const SEATS = Number(__ENV.SEATS || 50);

const won = new Counter('lotou_seat_reservations_ok');
const conflicts = new Counter('lotou_seat_conflicts');
const unexpected = new Counter('lotou_reservations_unexpected');
const reserveLatency = new Trend('lotou_reserve_duration', true);

export const options = {
  setupTimeout: '120s',
  scenarios: {
    warmup: WARMUP,
    contention: {
      startTime: '25s',
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '2m',
    },
  },
  thresholds: {
    lotou_reservations_unexpected: ['count==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const { producer, buyer } = tokens();
  const show = createShowOnSale(producer, { pista: 0, rows: 1, seatsPerRow: SEATS, name: 'disputa' });
  // Show do aquecimento: grande o bastante para não esgotar em 20 s.
  const warmup = createShowOnSale(producer, { pista: 200_000, rows: 0, seatsPerRow: 0, name: 'aquecimento' });
  console.log(`Show de teste: ${show.showId}`);
  return { ...show, warmup, token: buyer };
}

export function warmup(data) {
  warmupReservation(data);
}

export default function (data) {
  // De 1 a 4 cadeiras vizinhas entre as mesmas poucas: a maioria das tentativas se sobrepõe.
  const count = 1 + Math.floor(Math.random() * 4);
  const first = 1 + Math.floor(Math.random() * (SEATS - count + 1));
  const seats = Array.from({ length: count }, (_, i) => `A-${first + i}`);
  const response = http.post(
    `${INVENTORY_URL}/v1/reservations`,
    JSON.stringify({ showId: data.showId, sectorId: data.seatsId, seats, cpf: cpf() }),
    {
      headers: {
        Authorization: `Bearer ${data.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uuid(),
      },
      tags: { name: 'reserve-seats' },
    },
  );
  reserveLatency.add(response.timings.duration);
  if (response.status === 201) {
    won.add(1);
    return;
  }
  const type = response.status < 500 ? (response.json('type') || '') : '';
  const expected = ['seat-unavailable', 'sold-out', 'insufficient-stock'].some((slug) => type.endsWith(slug));
  check(response, { 'recusa esperada (cadeira ocupada)': () => expected });
  if (type.endsWith('seat-unavailable')) conflicts.add(1);
  if (!expected) unexpected.add(1, { status: String(response.status), type });
}
