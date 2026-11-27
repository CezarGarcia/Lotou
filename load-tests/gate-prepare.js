// Preparo do teste da portaria: um show com os portões abertos e ingressos comprados de verdade.
//
// Os ingressos da portaria vêm da cópia local do checkin-service, alimentada por TicketsIssued
// (ADR 14): por isso cada um passa pela compra inteira, com reserva, pedido e saga. Os pedidos
// são de 4 ingressos de pista, cada um com um CPF novo, e vão direto ao inventory e ao
// order-service, sem o rate limit por usuário do gateway (os serviços revalidam o token, ADR 21).
//
// O preparo pode ser repetido: com SHOW_ID, compra só o que falta para chegar a TICKETS ingressos
// válidos no show (VALID diz quantos já existem). Quem conta e espera a cópia local é o
// load-tests/gate.sh, chamado pelo `make load-gate-prepare`.
//
// Variáveis: TICKETS (padrão 30000), VALID (0), SHOW_ID (vazio: cria o show), CAPACITY (100000),
// VUS (compradores ao mesmo tempo, 10).
import { check } from 'k6';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import { buyerToken, buyPista, createShowOnSale, EVENT_SERVICE_URL, tokens } from './lib/lotou.js';

const TICKETS = Number(__ENV.TICKETS || 30_000);
const VALID = Number(__ENV.VALID || 0);
const VUS = Number(__ENV.VUS || 10);
const PER_ORDER = 4;
const ORDERS = Math.max(0, Math.ceil((TICKETS - VALID) / PER_ORDER));

const created = new Counter('lotou_gate_orders_created');
const failed = new Counter('lotou_gate_orders_failed');

export const options = {
  setupTimeout: '120s',
  scenarios: ORDERS
    ? {
        buy: {
          // Cada VU compra um pedido atrás do outro: o ritmo é o que o checkout aguenta, sem
          // pedido descartado por falta de VU, como no executor de ritmo fixo.
          executor: 'shared-iterations',
          vus: Math.min(VUS, ORDERS),
          iterations: ORDERS,
          maxDuration: '2h',
        },
      }
    : { nothing: { executor: 'shared-iterations', vus: 1, iterations: 1, exec: 'nothing' } },
  thresholds: {
    lotou_gate_orders_failed: ['count==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const { producer } = tokens();
  console.log(`Ingressos válidos no show: ${VALID}; meta: ${TICKETS}; pedidos a criar: ${ORDERS}`);
  if (__ENV.SHOW_ID) {
    const show = http.get(`${EVENT_SERVICE_URL}/v1/shows/${__ENV.SHOW_ID}`);
    if (show.status !== 200) throw new Error(`Show ${__ENV.SHOW_ID}: ${show.status}`);
    const pista = show.json('sectors').find((sector) => sector.kind === 'GENERAL_ADMISSION');
    return { showId: __ENV.SHOW_ID, pistaId: pista.id };
  }
  // Portões abertos há uma hora; o show começa daqui a 6 dias, para o preparo servir a semana toda.
  const show = createShowOnSale(producer, {
    pista: Number(__ENV.CAPACITY || 100_000),
    rows: 0,
    seatsPerRow: 0,
    name: 'portaria',
    startsAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    doorsOpenAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
  console.log(`Show da portaria criado: ${show.showId}`);
  return show;
}

export default function (data) {
  const { order, response } = buyPista(buyerToken(), data.showId, data.pistaId, PER_ORDER);
  const ok = check(response, { 'pedido criado': () => order !== null });
  if (ok) {
    created.add(1);
  } else {
    failed.add(1, { status: String(response.status) });
    console.warn(`Compra recusada: ${response.status} ${response.body}`);
  }
}

export function nothing() {}
