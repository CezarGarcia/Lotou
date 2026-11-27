// Geração dos ingressos com 1, 2 e 4 workers: a vazão da fila tickets.render cresce com eles.
//
// Rode pelo `make load-render` (load-tests/render.sh), que alterna as duas fases:
//
//   PHASE=buy    com o notification-service parado, compra ORDERS pedidos de 4 ingressos e espera
//                a saga confirmar todos: os TicketsIssued ficam esperando no Kafka.
//   PHASE=drain  com o notification-service de volta e RENDER_WORKERS=WORKERS, mede quantos PDFs
//                por segundo saem da fila tickets.render (acks na API de management do RabbitMQ)
//                durante WINDOW segundos, com a fila ainda cheia.
//
// A API de management atualiza as estatísticas a cada 5 s. A vazão é calculada entre a primeira e
// a última mudança do contador de acks na janela, que caem nas mesmas marcas de 5 s: a medida não
// depende de quando o k6 consultou.
//
// Variáveis: PHASE (buy ou drain), ORDERS (padrão 3000), VUS (10), WORKERS (só o rótulo da
// medida), WINDOW (40, em segundos).
import { check, sleep } from 'k6';
import { Counter, Gauge, Trend } from 'k6/metrics';
import { buyerToken, buyPista, createShowOnSale, rabbitQueue, tokens, waitOrdersSettled } from './lib/lotou.js';

const PHASE = __ENV.PHASE || 'buy';
const ORDERS = Number(__ENV.ORDERS || 3000);
const VUS = Number(__ENV.VUS || 10);
const WORKERS = __ENV.WORKERS || '?';
const WINDOW = Number(__ENV.WINDOW || 40);
const QUEUE = 'tickets.render';

const created = new Counter('lotou_render_orders_created');
const failed = new Counter('lotou_render_orders_failed');
const confirmedOrders = new Counter('lotou_render_orders_confirmed');
const throughput = new Gauge('lotou_render_pdfs_per_second');
const measured = new Counter('lotou_render_measured');
const renderRate = new Trend('lotou_render_rate');

export const options =
  PHASE === 'buy'
    ? {
        setupTimeout: '120s',
        teardownTimeout: '15m',
        scenarios: {
          buy: { executor: 'shared-iterations', vus: Math.min(VUS, ORDERS), iterations: ORDERS, maxDuration: '1h' },
        },
        thresholds: {
          lotou_render_orders_failed: ['count==0'],
          lotou_render_orders_confirmed: [`count==${ORDERS}`],
        },
      }
    : {
        scenarios: {
          drain: { executor: 'per-vu-iterations', vus: 1, iterations: 1, maxDuration: '10m', exec: 'drain' },
        },
        thresholds: { lotou_render_measured: ['count==1'] },
        summaryTrendStats: ['avg', 'max'],
      };

export function setup() {
  if (PHASE !== 'buy') return {};
  const { producer } = tokens();
  const show = createShowOnSale(producer, { pista: ORDERS * 4, rows: 0, seatsPerRow: 0, name: 'ingressos' });
  console.log(`Show de teste: ${show.showId}; ${ORDERS} pedidos de 4 ingressos`);
  return { ...show, since: Date.now() };
}

export default function (data) {
  const { order, response } = buyPista(buyerToken(), data.showId, data.pistaId, 4);
  if (order) {
    created.add(1);
  } else {
    failed.add(1, { status: String(response.status) });
    console.warn(`Compra recusada: ${response.status} ${response.body}`);
  }
}

export function teardown(data) {
  if (PHASE !== 'buy') return;
  const { buyer } = tokens();
  const { byStatus } = waitOrdersSettled(buyer, data.showId, data.since);
  console.log(`Pedidos do show: ${JSON.stringify(byStatus)}`);
  confirmedOrders.add(byStatus.CONFIRMED || 0);
}

/** Mede a vazão da fila durante WINDOW segundos, a partir do primeiro PDF confirmado. */
export function drain() {
  // O serviço acabou de subir: espera os consumidores aparecerem e a fila encher com os
  // RenderTickets que o consumidor do Kafka publica (as estatísticas chegam a cada 5 s).
  let queue = rabbitQueue(QUEUE);
  for (let waited = 0; !(queue.consumers > 0 && queue.messages > 0); waited++) {
    if (waited >= 120) throw new Error(`A fila ${QUEUE} não encheu: ${JSON.stringify(queue)}`);
    sleep(1);
    queue = rabbitQueue(QUEUE);
  }
  console.log(`${WORKERS} workers: ${queue.messages} tarefas na fila, ${queue.consumers} consumidores`);
  const changes = [];
  let last = queue.acked;
  let empty = 0;
  for (;;) {
    sleep(1);
    queue = rabbitQueue(QUEUE);
    if (queue.acked !== last) {
      last = queue.acked;
      changes.push({ at: Date.now(), acked: queue.acked });
    }
    empty = queue.messages === 0 ? empty + 1 : 0;
    const elapsed = changes.length ? (Date.now() - changes[0].at) / 1000 : 0;
    if (elapsed >= WINDOW || empty >= 6) break;
  }
  if (queue.messages === 0) {
    console.warn('A fila esvaziou antes do fim da janela: aumente ORDERS para medir com a fila cheia');
  }
  const ok = check(changes, { 'acks em pelo menos duas marcas de estatística': (c) => c.length >= 2 });
  if (!ok) return;
  const first = changes[0];
  const end = changes[changes.length - 1];
  const rate = (end.acked - first.acked) / ((end.at - first.at) / 1000);
  throughput.add(rate, { workers: WORKERS });
  renderRate.add(rate, { workers: WORKERS });
  measured.add(1);
  console.log(
    `${WORKERS} workers: ${rate.toFixed(1)} PDFs por segundo (${end.acked - first.acked} PDFs em ` +
      `${((end.at - first.at) / 1000).toFixed(0)} s); ${queue.messages} ainda na fila`,
  );
}
