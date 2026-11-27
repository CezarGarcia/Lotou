// Cupom disputado: mil compradores com o mesmo cupom de 100 usos, todos fechando o pedido juntos.
//
// O que prova: o limite do cupom é exato sob disputa (ADR 33). Exatamente 100 pedidos levam o
// cupom e os outros são recusados com coupon-invalid (EXHAUSTED); no banco orders, o cupom fica
// com uses = 100 e 100 pedidos (conferido por check-coupon.sql).
//
// Cada comprador reserva um ingresso de pista primeiro e espera o mesmo instante para criar o
// pedido com o cupom: a disputa é toda na linha do cupom, não na reserva. Reserva e pedido vão
// direto ao inventory e ao order-service, sem o rate limit do gateway.
//
// Variáveis: BUYERS (padrão 1000), LIMIT (usos do cupom, 100).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { createOrder, createShowOnSale, ORDER_URL, post, reservePista, tokens } from './lib/lotou.js';

const BUYERS = Number(__ENV.BUYERS || 1000);
const LIMIT = Number(__ENV.LIMIT || 100);

const withCoupon = new Counter('lotou_coupon_orders');
const exhausted = new Counter('lotou_coupon_exhausted');
const unexpected = new Counter('lotou_coupon_unexpected');
const orderLatency = new Trend('lotou_coupon_order_duration', true);
const retries = new Counter('lotou_coupon_order_retries');

export const options = {
  setupTimeout: '120s',
  scenarios: {
    buyers: {
      executor: 'per-vu-iterations',
      vus: BUYERS,
      iterations: 1,
      maxDuration: '3m',
    },
  },
  thresholds: {
    lotou_coupon_orders: [`count==${LIMIT}`],
    lotou_coupon_exhausted: [`count==${BUYERS - LIMIT}`],
    lotou_coupon_unexpected: ['count==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const { producer, buyer } = tokens();
  const show = createShowOnSale(producer, { pista: BUYERS, rows: 0, seatsPerRow: 0, name: 'cupom' });
  const code = `CARGA${Date.now().toString(36).toUpperCase()}`;
  // O order-service conhece o show pelo shows.catalog: logo depois da publicação, ele pode ainda
  // não ter chegado (404).
  let coupon;
  for (let attempt = 0; attempt < 30 && !coupon; attempt++) {
    try {
      coupon = post(`${ORDER_URL}/v1/coupons`, producer, {
        showId: show.showId,
        code,
        kind: 'PERCENT',
        percent: 10,
        maxUses: LIMIT,
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      });
    } catch (error) {
      if (!String(error).includes('-> 404')) throw error;
      sleep(1);
    }
  }
  if (!coupon) throw new Error('O order-service não recebeu o show do cupom');
  console.log(`Show ${show.showId}; cupom ${code} com ${LIMIT} usos para ${BUYERS} compradores`);
  // Todos os VUs reservam e esperam este instante para criar o pedido.
  return { ...show, code, couponId: coupon.id, producer, token: buyer, fireAt: Date.now() + 20_000 };
}

export default function (data) {
  const reservation = reservePista(data.token, data.showId, data.pistaId, 1);
  if (reservation.status !== 201) {
    unexpected.add(1, { step: 'reserve', status: String(reservation.status) });
    return;
  }
  sleep(Math.max(0, (data.fireAt - Date.now()) / 1000));

  // Com mil pedidos no mesmo instante, a leitura da reserva no inventory pode passar do prazo e o
  // order-service responde 503 (upstream-unavailable, "tente novamente"): o comprador tenta de novo,
  // como a loja faria. Repetir é seguro: o pedido é único por reserva.
  let response = createOrder(data.token, reservation.json('id'), data.code);
  orderLatency.add(response.timings.duration);
  for (let attempt = 1; attempt <= 3 && response.status === 503; attempt++) {
    retries.add(1);
    sleep(attempt);
    response = createOrder(data.token, reservation.json('id'), data.code);
  }
  if (response.status === 201 && response.json('couponCode') === data.code) {
    withCoupon.add(1);
    return;
  }
  const refused =
    response.status === 422 &&
    String(response.json('type') || '').endsWith('coupon-invalid') &&
    response.json('reason') === 'EXHAUSTED';
  check(response, { 'pedido com o cupom ou cupom esgotado': () => refused });
  if (refused) {
    exhausted.add(1);
  } else {
    unexpected.add(1, { step: 'order', status: String(response.status) });
    console.warn(`Resposta inesperada: ${response.status} ${response.body}`);
  }
}

export function teardown(data) {
  const response = http.get(`${ORDER_URL}/v1/coupons?showId=${data.showId}`, {
    headers: { Authorization: `Bearer ${data.producer}` },
  });
  const coupon = response.json('items').find((item) => item.id === data.couponId);
  console.log(`Cupom ${coupon.code}: ${coupon.uses} de ${coupon.maxUses} usos, status ${coupon.status}`);
  check(coupon, { 'cupom com todos os usos e nenhum a mais': (c) => c.uses === LIMIT && c.remaining === 0 });
}
