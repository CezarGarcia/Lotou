import { performance } from 'node:perf_hooks';
import {
  type ApiClient,
  createTestApp,
  type TestApp,
  waitForShow,
  waitForTickets,
} from './support/app.js';
import { showMessage, ticketsIssued } from './support/fixtures.js';
import { EventSender } from './support/kafka.js';

const SCANS = 200;
/**
 * A meta do documento é p99 abaixo de 200 ms (docs/projeto.md, "Requisitos não
 * funcionais"), medida no ambiente de verdade. Aqui a máquina é dividida com
 * outros testes e containers, então a asserção tem folga; o número medido vai
 * para a saída do teste.
 */
const P99_BUDGET_MS = 600;

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

describe('Latência da leitura do QR', () => {
  let t: TestApp;
  let sender: EventSender;
  let gate: ApiClient;

  beforeAll(async () => {
    [t, sender] = await Promise.all([createTestApp(), EventSender.start()]);
    gate = await t.as(['gate-staff']);
  });
  afterAll(async () => {
    await Promise.all([t?.close(), sender?.stop()]);
  });

  it(`${SCANS} leituras seguidas, cada uma de um ingresso: p99 dentro da meta`, async () => {
    const show = showMessage();
    const showId = show.payload.showId as string;
    await sender.catalog(show);
    // Quatro pedidos de 50 ingressos.
    const orders = Array.from({ length: SCANS / 50 }, () =>
      ticketsIssued(showId, 50),
    );
    for (const order of orders) {
      await sender.order(order);
    }
    const tickets = orders.flatMap((order) => order.payload.tickets);
    await waitForShow(t.pool, showId);
    await waitForTickets(
      t.pool,
      tickets.map((ticket) => ticket.ticketId),
    );

    // Aquece o pool, o JIT e o Redis com leituras que não contam.
    for (let i = 0; i < 10; i++) {
      await gate
        .post('/v1/checkins', { showId, gate: 'Aquecimento', code: 'x' })
        .expect(200);
    }

    const durations: number[] = [];
    const results = new Map<string, number>();
    for (const [index, ticket] of tickets.entries()) {
      // Um em cada dez lido de novo, como quem passa o QR duas vezes.
      const code = index % 10 === 9 ? tickets[index - 1].code : ticket.code;
      const startedAt = performance.now();
      const response = await gate
        .post('/v1/checkins', {
          showId,
          gate: `Portão ${(index % 4) + 1}`,
          code,
        })
        .expect(200);
      durations.push(performance.now() - startedAt);
      results.set(
        response.body.result,
        (results.get(response.body.result) ?? 0) + 1,
      );
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const p99 = percentile(sorted, 99);
    console.info(
      `Leitura do QR (${SCANS} leituras pela API, com token): p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, máx ${sorted.at(-1)!.toFixed(1)} ms`,
    );

    expect(Object.fromEntries(results)).toEqual({
      ACCEPTED: 180,
      ALREADY_USED: 20,
    });
    expect(p99).toBeLessThan(P99_BUDGET_MS);
  });
});
