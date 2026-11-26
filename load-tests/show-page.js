// Página do show com o cache ligado e desligado (SHOW_CACHE_ENABLED no event-service).
//
// O que prova: o ganho real de latência do cache-aside e a taxa de acerto (cache_requests_total
// no Grafana). Lê direto do event-service, sem o gateway. Rode com RATE_LIMIT_ENABLED=false no
// event-service: todos os VUs saem do mesmo IP e a janela deslizante os barraria.
//
// Variáveis: VUS (padrão 200), DURATION (30s).
import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { createShowOnSale, EVENT_SERVICE_URL, tokens } from './lib/lotou.js';

const pageLatency = new Trend('lotou_show_page_duration', true);

export const options = {
  setupTimeout: '120s',
  scenarios: {
    page: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 200),
      duration: __ENV.DURATION || '30s',
    },
  },
  thresholds: {
    // Meta do documento: leitura de show com cache, p95 abaixo de 30 ms.
    lotou_show_page_duration: [{ threshold: 'p(95)<30', abortOnFail: false }],
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const { producer } = tokens();
  return createShowOnSale(producer, { pista: 1000, rows: 0, seatsPerRow: 0, name: 'pagina' });
}

export default function (data) {
  const response = http.get(`${EVENT_SERVICE_URL}/v1/shows/${data.showId}`, { tags: { name: 'show-page' } });
  pageLatency.add(response.timings.duration);
  check(response, { 'página do show': (r) => r.status === 200 });
}
