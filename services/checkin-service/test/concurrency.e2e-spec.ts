import type { Pool } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { FirstEntryStore } from '../src/checkin/first-entry.store.js';
import {
  type ApiClient,
  createTestApp,
  type TestApp,
  waitForShow,
  waitForTickets,
} from './support/app.js';
import { contractErrors } from './support/contracts.js';
import { showMessage, ticketsIssued } from './support/fixtures.js';
import { EventSender, TopicRecorder } from './support/kafka.js';

const GATES = Array.from({ length: 10 }, (_, i) => `Portão ${i + 1}`);

// Ninguém escuta na porta 1: a conexão é recusada na hora.
const NOWHERE = 'redis://127.0.0.1:1';

async function checkinRows(pool: Pool, ticketId: string) {
  const { rows } = await pool.query<{ gate: string }>(
    'SELECT gate FROM checkins WHERE ticket_id = $1',
    [ticketId],
  );
  return rows;
}

/**
 * Segura cada leitura logo antes do Redis até as `count` chegarem: todas
 * passaram pela consulta à cópia local com o ingresso ainda `VALID`, e só
 * então disputam a entrada. Sem isso, os portões que chegam depois do
 * primeiro COMMIT já leem `USED` do banco, e a corrida não acontece de fato.
 * Também guarda o que o Redis respondeu a cada um (`claimed`, `taken`...).
 */
function raceAtClaim(t: TestApp, count: number) {
  const store = t.app.get(FirstEntryStore);
  const original = store.claim.bind(store);
  let resolve!: () => void;
  const allArrived = new Promise<void>((done) => (resolve = done));
  let arrived = 0;
  const claim = vi.spyOn(store, 'claim').mockImplementation(async (...args) => {
    if (++arrived === count) {
      resolve();
    }
    await Promise.race([allArrived, sleep(5_000)]);
    return original(...args);
  });
  return {
    outcomes: async () => {
      const claims = await Promise.all(
        claim.mock.results.map((result) => result.value),
      );
      return claims.map((c: { outcome: string }) => c.outcome).sort();
    },
    restore: () => claim.mockRestore(),
  };
}

describe('Corrida entre portões', () => {
  let sender: EventSender;
  let recorder: TopicRecorder;

  beforeAll(async () => {
    [sender, recorder] = await Promise.all([
      EventSender.start(),
      TopicRecorder.start(),
    ]);
  });
  afterAll(async () => {
    await Promise.all([sender?.stop(), recorder?.stop()]);
  });

  /** Um show aberto com um ingresso, já na cópia local da aplicação. */
  async function oneTicket(t: TestApp) {
    const show = showMessage();
    const issued = ticketsIssued(show.payload.showId);
    await sender.catalog(show);
    await sender.order(issued);
    await waitForShow(t.pool, show.payload.showId);
    await waitForTickets(t.pool, [issued.payload.tickets[0].ticketId]);
    return {
      showId: show.payload.showId as string,
      ...issued.payload.tickets[0],
    };
  }

  /** Os dez portões leem o mesmo QR ao mesmo tempo. */
  function scanEverywhere(gate: ApiClient, showId: string, code: string) {
    return Promise.all(
      GATES.map((name) =>
        gate
          .post('/v1/checkins', { showId, gate: name, code })
          .expect(200)
          .then((response) => ({ gate: name, ...response.body })),
      ),
    );
  }

  describe('com o Redis no ar', () => {
    let t: TestApp;
    let gate: ApiClient;

    beforeAll(async () => {
      t = await createTestApp();
      gate = await t.as(['gate-staff']);
    });
    afterAll(() => t?.close());

    it('dez portões com o mesmo QR: exatamente uma entrada, nove "já utilizado"', async () => {
      const ticket = await oneTicket(t);
      const claims = raceAtClaim(t, GATES.length);

      const results = await scanEverywhere(gate, ticket.showId, ticket.code);

      const accepted = results.filter((r) => r.result === 'ACCEPTED');
      const used = results.filter((r) => r.result === 'ALREADY_USED');
      expect(accepted).toHaveLength(1);
      expect(used).toHaveLength(9);
      // Quem decidiu foi o SET NX: um portão marcou, os outros nove acharam a
      // marca (sem precisar da constraint).
      expect(await claims.outcomes()).toEqual([
        'claimed',
        ...Array(9).fill('taken'),
      ]);
      claims.restore();
      // Todos apontam a mesma primeira entrada: o portão que ganhou.
      for (const result of used) {
        expect(result.firstEntry.gate).toBe(accepted[0].gate);
      }
      expect(await checkinRows(t.pool, ticket.ticketId)).toEqual([
        { gate: accepted[0].gate },
      ]);

      // Uma entrada publicada e nove recusas, todas no contrato.
      const events = await recorder.waitForEvents(ticket.showId, 10);
      expect(
        events.filter((e) => e.value.type === 'TicketCheckedIn'),
      ).toHaveLength(1);
      expect(
        events.filter(
          (e) =>
            e.value.type === 'CheckinRejected' &&
            e.value.payload.reason === 'ALREADY_USED',
        ),
      ).toHaveLength(9);
      for (const event of events) {
        expect(contractErrors('checkin.events', event.value)).toEqual([]);
      }
    });

    it('o Redis perdeu os dados: a cópia local ainda sabe que o ingresso foi usado', async () => {
      const ticket = await oneTicket(t);
      const first = await gate
        .post('/v1/checkins', {
          showId: ticket.showId,
          gate: 'Portão A',
          code: ticket.code,
        })
        .expect(200);
      expect(first.body.result).toBe('ACCEPTED');

      await t.redis.flushdb();
      const again = await gate
        .post('/v1/checkins', {
          showId: ticket.showId,
          gate: 'Portão B',
          code: ticket.code,
        })
        .expect(200);

      expect(again.body).toMatchObject({
        result: 'ALREADY_USED',
        firstEntry: { gate: 'Portão A' },
      });
      expect(await checkinRows(t.pool, ticket.ticketId)).toHaveLength(1);
    });

    it('marca de um portão que caiu antes de gravar no banco: depois do prazo, não vale mais', async () => {
      const ticket = await oneTicket(t);
      // Um processo marcou o Redis há um minuto e morreu antes do Postgres.
      await t.redis.set(
        `checkin:${ticket.ticketId}`,
        JSON.stringify({
          at: new Date(Date.now() - 60_000).toISOString(),
          gate: 'Portão Fantasma',
        }),
      );

      const response = await gate
        .post('/v1/checkins', {
          showId: ticket.showId,
          gate: 'Portão A',
          code: ticket.code,
        })
        .expect(200);

      expect(response.body.result).toBe('ACCEPTED');
      expect(await checkinRows(t.pool, ticket.ticketId)).toEqual([
        { gate: 'Portão A' },
      ]);
      // O Redis fica com a entrada verdadeira.
      expect(await t.redis.get(`checkin:${ticket.ticketId}`)).toContain(
        'Portão A',
      );
    });
  });

  describe('com o Redis fora do ar', () => {
    let t: TestApp;
    let gate: ApiClient;

    beforeAll(async () => {
      t = await createTestApp({ REDIS_URL: NOWHERE });
      gate = await t.as(['gate-staff']);
    });
    afterAll(() => t?.close());

    it('a constraint única sozinha deixa uma entrada só', async () => {
      const ticket = await oneTicket(t);
      const claims = raceAtClaim(t, GATES.length);

      const results = await scanEverywhere(gate, ticket.showId, ticket.code);

      const accepted = results.filter((r) => r.result === 'ACCEPTED');
      const used = results.filter((r) => r.result === 'ALREADY_USED');
      expect(accepted).toHaveLength(1);
      expect(used).toHaveLength(9);
      // Os dez foram ao banco ao mesmo tempo, sem resposta do Redis: quem
      // decidiu foi a constraint única.
      expect(await claims.outcomes()).toEqual(Array(10).fill('unavailable'));
      claims.restore();
      for (const result of used) {
        expect(result.firstEntry.gate).toBe(accepted[0].gate);
      }
      expect(await checkinRows(t.pool, ticket.ticketId)).toEqual([
        { gate: accepted[0].gate },
      ]);
      const events = await recorder.waitForEvents(ticket.showId, 10);
      expect(
        events.filter((e) => e.value.type === 'TicketCheckedIn'),
      ).toHaveLength(1);
    });
  });
});
