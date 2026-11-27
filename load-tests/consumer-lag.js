// Pico de pedidos com o consumidor lento: o analytics-service fica parado durante o pico.
//
// O que prova: o lag do consumer group do analytics sobe enquanto ele está fora e volta a zero
// quando ele volta, sem perder evento: no fim, o relatório do show no analytics bate com os
// pedidos do order-service (contagem, confirmados, ingressos e valores). check-consumer-lag.sql
// mostra os mesmos números lidos do banco orders.
//
// Quem para e sobe o analytics é o load-tests/consumer-lag.sh (make load-consumer-lag): ele para o
// serviço antes do k6, e o sobe de novo PAUSE segundos depois, com o pico já terminado.
//
// Dois cenários: `spike` compra pedidos de 1 a 4 ingressos de pista com VUS compradores por
// DURATION; `watch` lê o lag pelo Kafka UI a cada 2 s (métrica lotou_analytics_lag, que vai ao
// Prometheus) até ele voltar a zero com o analytics de volta.
//
// Variáveis: VUS (padrão 20), DURATION (60s), WATCH_TIMEOUT (900, em segundos).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Gauge, Trend } from 'k6/metrics';
import {
  buyerToken,
  buyPista,
  consumerLag,
  createShowOnSale,
  tokens,
  waitOrdersSettled,
} from './lib/lotou.js';

const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '60s';
const WATCH_TIMEOUT = Number(__ENV.WATCH_TIMEOUT || 900);
const ANALYTICS_URL = __ENV.ANALYTICS_URL || 'http://analytics-service:8084';
const GROUP_PREFIX = 'analytics-service.gen-';

const created = new Counter('lotou_spike_orders_created');
const failed = new Counter('lotou_spike_orders_failed');
const lagGauge = new Gauge('lotou_analytics_lag');
const lagSamples = new Trend('lotou_analytics_lag_samples');
const recovery = new Trend('lotou_analytics_lag_recovery_seconds');
const recovered = new Counter('lotou_analytics_lag_recovered');
const mismatches = new Counter('lotou_analytics_mismatches');

export const options = {
  setupTimeout: '120s',
  teardownTimeout: '15m',
  scenarios: {
    spike: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      startTime: '5s',
    },
    watch: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: `${WATCH_TIMEOUT}s`,
      exec: 'watch',
    },
  },
  thresholds: {
    lotou_spike_orders_failed: ['count==0'],
    // O lag precisa ter subido (o analytics estava parado) e voltado a zero (medido no watch).
    lotou_analytics_lag_samples: ['max>0'],
    lotou_analytics_lag_recovered: ['count==1'],
    lotou_analytics_mismatches: ['count==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const { producer } = tokens();
  // O lag de antes do pico é a linha de base. Ele raramente é zero com o consumidor em dia: o
  // event-service publica em transações Kafka (ADR 29), e o marcador de commit ocupa um offset que
  // o consumidor não confirma, então a partição cujo último registro veio numa transação fica com 1.
  const lag = consumerLag(GROUP_PREFIX);
  console.log(`Consumer group ${lag.group}: lag ${lag.lag}, ${lag.members} consumidores (${lag.state})`);
  const show = createShowOnSale(producer, { pista: 200_000, rows: 0, seatsPerRow: 0, name: 'consumidor lento' });
  console.log(`Show de teste: ${show.showId}`);
  return {
    ...show,
    baseline: lag.lag,
    since: Date.now() - 5_000,
    spikeEndsAt: Date.now() + 5_000 + parseDuration(DURATION),
  };
}

export default function (data) {
  const quantity = 1 + Math.floor(Math.random() * 4);
  const { order, response } = buyPista(buyerToken(), data.showId, data.pistaId, quantity);
  if (order) {
    created.add(1);
  } else {
    failed.add(1, { status: String(response.status) });
    console.warn(`Compra recusada: ${response.status} ${response.body}`);
  }
}

/** Lê o lag até ele voltar à linha de base depois do pico, com o analytics consumindo de novo. */
export function watch(data) {
  let max = 0;
  let backAt = null;
  let caughtUp = 0;
  for (;;) {
    const lag = consumerLag(GROUP_PREFIX);
    lagGauge.add(lag.lag);
    lagSamples.add(lag.lag);
    max = Math.max(max, lag.lag);
    const now = Date.now();
    if (lag.members > 0 && backAt === null && now > data.spikeEndsAt) {
      backAt = now;
      console.log(`Analytics de volta (${lag.group}) com lag de ${lag.lag}`);
    }
    caughtUp = lag.lag <= data.baseline && backAt !== null ? caughtUp + 1 : 0;
    if (caughtUp >= 2) {
      const seconds = (now - backAt) / 1000;
      recovery.add(seconds);
      recovered.add(1);
      console.log(
        `Lag de volta à linha de base (${data.baseline}) ${seconds.toFixed(0)} s depois de o analytics voltar; ` +
          `máximo: ${max}`,
      );
      break;
    }
    sleep(2);
  }
}

export function teardown(data) {
  const { producer, buyer } = tokens();
  const { orders, byStatus } = waitOrdersSettled(buyer, data.showId, data.since);
  const confirmed = orders.filter((order) => order.status === 'CONFIRMED');
  const expected = {
    ordersCreated: orders.length,
    confirmedOrders: confirmed.length,
    ticketsSold: confirmed.reduce((sum, order) => sum + order.tickets, 0),
    totalCents: confirmed.reduce((sum, order) => sum + order.totalCents, 0),
  };
  console.log(`order-service: ${JSON.stringify(byStatus)}; ${JSON.stringify(expected)}`);

  // O pedido mais recente pode ter sido confirmado depois do lag zerar: espera o relatório fechar.
  let report;
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = http.get(`${ANALYTICS_URL}/v1/analytics/shows/${data.showId}/statement`, {
      headers: { Authorization: `Bearer ${producer}` },
    });
    if (response.status === 200) {
      const s = response.json();
      report = {
        ordersCreated: s.ordersCreated,
        confirmedOrders: s.confirmedOrders,
        ticketsSold: s.ticketsSold,
        totalCents: s.grossSalesCents - s.discountsCents + s.buyerFeesCents,
      };
      if (JSON.stringify(report) === JSON.stringify(expected)) break;
    }
    sleep(2);
  }
  console.log(`analytics:     ${JSON.stringify(report)}`);
  for (const key of Object.keys(expected)) {
    const same = report && report[key] === expected[key];
    check(null, { [`analytics bate com o order-service: ${key}`]: () => same });
    if (!same) mismatches.add(1, { field: key });
  }
}

function parseDuration(text) {
  const match = /^(\d+)(ms|s|m)$/.exec(text);
  if (!match) throw new Error(`DURATION inválida: ${text}`);
  return Number(match[1]) * { ms: 1, s: 1000, m: 60_000 }[match[2]];
}
