// Portaria: milhares de check-ins em 10 portões, com 5% de leituras repetidas de propósito.
//
// O que prova: nenhuma entrada dupla (cada ingresso liberado uma vez só; as leituras repetidas
// respondem ALREADY_USED) e o p99 do POST /v1/checkins abaixo de 200 ms, a meta do alerta
// "Portaria lenta". As entradas são conferidas no banco checkin por check-gate.sql.
//
// Rode pelo `make load-gate`, depois do `make load-gate-prepare`: o gate.sh exporta os ingressos
// válidos do show preparado para .data/gate-tickets.txt. O QR code de cada um é montado como o
// order-service o emite (LOTOU1.<id>.<HMAC>, ADR 15), com a chave de desenvolvimento.
//
// Metade das repetidas vem logo depois da primeira leitura, em outro portão (a corrida entre
// portões que o SET NX no Redis decide); a outra metade, umas 500 leituras depois (o ingresso
// passado para outra pessoa). O check-in vai direto ao checkin-service, sem o gateway.
//
// O ritmo padrão (150 leituras/s, 30 mil em 3 min 30 s) é quase 20 vezes o de uma portaria real;
// nesta máquina de 4 CPUs o checkin-service satura perto de 265/s (load-tests/README.md).
//
// Variáveis: SHOW_ID (obrigatório), RATE (leituras por segundo, padrão 150), GATES (10),
// REPEAT_RATE (0.05), TICKET_QR_KEY (a de desenvolvimento).
import crypto from 'k6/crypto';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { buyerToken, CHECKIN_URL } from './lib/lotou.js';

const SHOW_ID = __ENV.SHOW_ID;
const RATE = Number(__ENV.RATE || 150);
const GATES = Number(__ENV.GATES || 10);
const REPEAT_RATE = Number(__ENV.REPEAT_RATE || 0.05);
const QR_KEY = __ENV.TICKET_QR_KEY || 'lotou-dev-ticket-qr-key';
const LATE_REPEAT = 500;

const GATE_NAMES = Array.from({ length: GATES }, (_, i) => `Portão ${String.fromCharCode(65 + i)}`);

/** A sequência de leituras, montada uma vez e compartilhada pelos VUs. */
const scans = new SharedArray('leituras', () => {
  const ids = open('./.data/gate-tickets.txt')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const code = (id) => `LOTOU1.${id}.${crypto.hmac('sha256', QR_KEY, `LOTOU1.${id}`, 'base64rawurl')}`;
  const every = Math.round(1 / REPEAT_RATE);
  const out = [];
  const late = [];
  ids.forEach((id, i) => {
    const first = { code: code(id), gate: i % GATES, repeat: false };
    out.push(first);
    if ((i + 1) % every === 0) {
      const repeat = { code: first.code, gate: (i + 1 + Math.floor(GATES / 2)) % GATES, repeat: true };
      if (((i + 1) / every) % 2 === 1) {
        out.push(repeat); // na hora, em outro portão
      } else {
        late.push({ due: i + LATE_REPEAT, scan: repeat });
      }
    }
    while (late.length && late[0].due <= i) out.push(late.shift().scan);
  });
  for (const pending of late) out.push(pending.scan);
  return out;
});

const TOTAL = scans.length;
const REPEATS = Math.floor(TOTAL / (Math.round(1 / REPEAT_RATE) + 1));
const TICKETS = TOTAL - REPEATS;

const accepted = new Counter('lotou_checkins_accepted');
const alreadyUsed = new Counter('lotou_checkins_already_used');
const unexpected = new Counter('lotou_checkins_unexpected');
const checkinLatency = new Trend('lotou_checkin_duration', true);

export const options = {
  setupTimeout: '60s',
  scenarios: {
    gates: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: `${Math.ceil(TOTAL / RATE)}s`,
      preAllocatedVUs: Number(__ENV.VUS || 200),
      maxVUs: Number(__ENV.MAX_VUS || 500),
    },
  },
  thresholds: {
    // Meta do alerta "Portaria lenta": p99 do check-in abaixo de 200 ms.
    lotou_checkin_duration: ['p(99)<200'],
    // Cada ingresso entra uma vez; cada leitura repetida é barrada.
    lotou_checkins_accepted: [`count==${TICKETS}`],
    lotou_checkins_already_used: [`count==${REPEATS}`],
    lotou_checkins_unexpected: ['count==0'],
  },
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  if (!SHOW_ID) throw new Error('Informe SHOW_ID (rode pelo make load-gate)');
  console.log(`${TICKETS} ingressos e ${REPEATS} leituras repetidas em ${GATES} portões, ${RATE} leituras/s`);
  return { token: buyerToken() };
}

/** O token do setup vale 5 minutos; numa rodada mais longa, cada VU renova o seu. */
function token(data) {
  return TOTAL / RATE < 240 ? data.token : buyerToken();
}

export default function (data) {
  const index = exec.scenario.iterationInTest;
  if (index >= TOTAL) return;
  const scan = scans[index];
  const gate = GATE_NAMES[scan.gate];
  const response = http.post(`${CHECKIN_URL}/v1/checkins`, JSON.stringify({ showId: SHOW_ID, gate, code: scan.code }), {
    headers: { Authorization: `Bearer ${token(data)}`, 'Content-Type': 'application/json' },
    tags: { name: 'checkin', gate },
  });
  checkinLatency.add(response.timings.duration);
  const result = response.status === 200 ? response.json('result') : `HTTP ${response.status}`;
  if (result === 'ACCEPTED') {
    accepted.add(1);
  } else if (result === 'ALREADY_USED') {
    alreadyUsed.add(1);
  } else {
    unexpected.add(1, { result });
  }
  check(result, {
    'leitura liberada ou já utilizada': (r) => r === 'ACCEPTED' || r === 'ALREADY_USED',
  });
}
