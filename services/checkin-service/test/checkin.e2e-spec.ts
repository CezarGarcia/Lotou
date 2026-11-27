import { newId } from '../src/common/ids.js';
import {
  createTestApp,
  eventually,
  type ApiClient,
  type TestApp,
  waitForShow,
  waitForTickets,
} from './support/app.js';
import { contractErrors } from './support/contracts.js';
import {
  codeOf,
  legacyCodeOf,
  newTraceparent,
  showMessage,
  ticketsIssued,
  traceIdOf,
} from './support/fixtures.js';
import { EventSender, TopicRecorder } from './support/kafka.js';

const HOUR = 60 * 60 * 1000;

describe('Leitura do QR na portaria', () => {
  let t: TestApp;
  let sender: EventSender;
  let recorder: TopicRecorder;
  let gate: ApiClient;

  /** Um show com os portões abertos e ingressos emitidos, já na cópia local. */
  async function showWithTickets(count = 1, showOptions = {}) {
    const show = showMessage(showOptions);
    const issued = ticketsIssued(show.payload.showId, count);
    await sender.catalog(show);
    await sender.order(issued);
    await waitForShow(t.pool, show.payload.showId);
    await waitForTickets(
      t.pool,
      issued.payload.tickets.map((ticket) => ticket.ticketId),
    );
    return {
      showId: show.payload.showId as string,
      producerId: show.payload.producerId as string,
      orderId: issued.payload.orderId,
      tickets: issued.payload.tickets,
    };
  }

  const scan = (showId: string, code: string, gateName = 'Portão A') =>
    gate.post('/v1/checkins', { showId, gate: gateName, code }).expect(200);

  beforeAll(async () => {
    [t, sender, recorder] = await Promise.all([
      createTestApp(),
      EventSender.start(),
      TopicRecorder.start(),
    ]);
    gate = await t.as(['gate-staff']);
  });
  afterAll(async () => {
    await Promise.all([t?.close(), sender?.stop(), recorder?.stop()]);
  });

  it('libera o ingresso emitido e publica TicketCheckedIn, com o trace da leitura', async () => {
    const { showId, orderId, tickets } = await showWithTickets();
    const [ticket] = tickets;
    const { traceparent, traceId } = newTraceparent();

    const response = await gate
      .post('/v1/checkins', { showId, gate: 'Portão B', code: ticket.code })
      .set('traceparent', traceparent)
      .expect(200);

    expect(response.body).toEqual({
      result: 'ACCEPTED',
      ticket: { ticketId: ticket.ticketId, sectorName: 'Plateia', seat: 'A-1' },
      firstEntry: null,
    });

    const [event] = await recorder.waitForEvents(showId);
    expect(contractErrors('checkin.events', event.value)).toEqual([]);
    expect(event.value).toMatchObject({
      type: 'TicketCheckedIn',
      payload: {
        ticketId: ticket.ticketId,
        showId,
        orderId,
        sectorId: ticket.sectorId,
        sectorName: 'Plateia',
        seat: 'A-1',
        gate: 'Portão B',
      },
    });
    expect(traceIdOf(event.headers.traceparent)).toBe(traceId);

    const { rows } = await t.pool.query(
      'SELECT gate FROM checkins WHERE ticket_id = $1',
      [ticket.ticketId],
    );
    expect(rows).toEqual([{ gate: 'Portão B' }]);
    expect(await t.redis.get(`checkin:${ticket.ticketId}`)).toContain(
      'Portão B',
    );
  });

  it('a segunda leitura é "já utilizado", com o horário e o portão da primeira', async () => {
    const { showId, tickets } = await showWithTickets();
    const first = await scan(showId, tickets[0].code, 'Portão B');
    expect(first.body.result).toBe('ACCEPTED');

    const second = await scan(showId, tickets[0].code, 'Portão C');

    expect(second.body).toMatchObject({
      result: 'ALREADY_USED',
      ticket: { ticketId: tickets[0].ticketId },
      firstEntry: { gate: 'Portão B' },
    });
    const at = new Date(second.body.firstEntry.at).getTime();
    expect(Math.abs(at - Date.now())).toBeLessThan(10_000);

    const events = await recorder.waitForEvents(showId, 2);
    expect(events.map((e) => e.value.type)).toEqual([
      'TicketCheckedIn',
      'CheckinRejected',
    ]);
    expect(contractErrors('checkin.events', events[1].value)).toEqual([]);
    expect(events[1].value.payload).toMatchObject({
      reason: 'ALREADY_USED',
      ticketId: tickets[0].ticketId,
      gate: 'Portão C',
    });
  });

  it('o QR do order-service é LOTOU2 (Ed25519) e entra', async () => {
    const { showId, tickets } = await showWithTickets();
    expect(tickets[0].code).toMatch(/^LOTOU2\./);
    expect((await scan(showId, tickets[0].code)).body.result).toBe('ACCEPTED');
  });

  it('o QR antigo LOTOU1 (HMAC), de ingresso já emitido, continua entrando uma vez só', async () => {
    const { showId, tickets } = await showWithTickets();
    const legacy = legacyCodeOf(tickets[0].ticketId);

    expect((await scan(showId, legacy)).body).toMatchObject({
      result: 'ACCEPTED',
      ticket: { ticketId: tickets[0].ticketId },
    });
    // O mesmo ingresso pelo código novo: é a mesma entrada.
    expect(
      (await scan(showId, tickets[0].code, 'Portão C')).body,
    ).toMatchObject({
      result: 'ALREADY_USED',
      firstEntry: { gate: 'Portão A' },
    });
    // Assinatura HMAC que não confere: recusada.
    const forged = legacyCodeOf(tickets[0].ticketId).replace(
      /\.[^.]+$/,
      `.${'A'.repeat(43)}`,
    );
    expect((await scan(showId, forged)).body.result).toBe('INVALID_CODE');
  });

  it('o leitor que manda um Enter no fim do código também é aceito', async () => {
    const { showId, tickets } = await showWithTickets();
    const response = await scan(showId, `${tickets[0].code}\r\n`);
    expect(response.body.result).toBe('ACCEPTED');
  });

  it('QR falsificado é INVALID_CODE sem nenhuma consulta ao banco', async () => {
    const { showId, tickets } = await showWithTickets();
    // Um caractere do meio da assinatura trocado: outra assinatura, mesmo formato.
    const code = tickets[0].code;
    const at = code.length - 20;
    const forged =
      code.slice(0, at) + (code[at] === 'A' ? 'B' : 'A') + code.slice(at + 1);

    // Enquanto a leitura acontece, o banco "não existe": qualquer consulta
    // falha. O relay e a gravação das recusas, que rodam em segundo plano,
    // ficam parados nesse intervalo, para só a leitura usar o pool.
    await t.relay.stop();
    const query = vi.spyOn(t.pool, 'query').mockImplementation(() => {
      throw new Error('a leitura de um QR falso não pode consultar o banco');
    });
    const connect = vi.spyOn(t.pool, 'connect').mockImplementation(() => {
      throw new Error('a leitura de um QR falso não pode consultar o banco');
    });
    const flush = vi.spyOn(t.rejections, 'flush').mockResolvedValue(0);
    let responses;
    try {
      responses = await Promise.all([
        scan(showId, forged),
        scan(showId, 'https://outro-sistema.example/ingresso/123'),
        scan(showId, `LOTOU1.${tickets[0].ticketId}`),
      ]);
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
      connect.mockRestore();
      flush.mockRestore();
      t.relay.start();
    }

    for (const response of responses) {
      expect(response.body).toEqual({
        result: 'INVALID_CODE',
        ticket: null,
        firstEntry: null,
      });
    }
    // A recusa é gravada depois, em lote, e publicada sem o ID do ingresso.
    const events = await recorder.waitForEvents(showId, 3);
    for (const event of events) {
      expect(contractErrors('checkin.events', event.value)).toEqual([]);
      expect(event.value.payload).toMatchObject({
        reason: 'INVALID_CODE',
        ticketId: null,
      });
    }
    expect(await ticketStatusIs(tickets[0].ticketId, 'VALID')).toBe(true);
  });

  it('ingresso com assinatura válida que a cópia local não conhece: UNKNOWN_TICKET', async () => {
    const { showId } = await showWithTickets();
    const unknown = newId();

    const response = await scan(showId, codeOf(unknown));

    expect(response.body).toEqual({
      result: 'UNKNOWN_TICKET',
      ticket: null,
      firstEntry: null,
    });
    const [event] = await recorder.waitForEvents(showId);
    expect(event.value.payload).toMatchObject({
      reason: 'UNKNOWN_TICKET',
      ticketId: unknown,
    });
  });

  it('ingresso de outro show: WRONG_SHOW, e o ingresso continua valendo no show dele', async () => {
    const { showId, tickets } = await showWithTickets();
    const other = await showWithTickets();

    const wrong = await scan(other.showId, tickets[0].code);
    expect(wrong.body).toMatchObject({
      result: 'WRONG_SHOW',
      ticket: { ticketId: tickets[0].ticketId, sectorName: 'Plateia' },
    });

    expect((await scan(showId, tickets[0].code)).body.result).toBe('ACCEPTED');
  });

  it('antes da abertura dos portões: NOT_OPEN, e depois libera', async () => {
    const startsAt = new Date(Date.now() + 5 * HOUR);
    const { showId, tickets } = await showWithTickets(1, {
      startsAt,
      doorsOpenAt: new Date(startsAt.getTime() - HOUR),
    });

    expect((await scan(showId, tickets[0].code)).body.result).toBe('NOT_OPEN');

    // O produtor antecipa a abertura: o ShowUpdated chega e a porta abre.
    await sender.catalog(
      showMessage({
        showId,
        version: 2,
        type: 'ShowUpdated',
        startsAt,
        doorsOpenAt: new Date(Date.now() - 60_000),
      }),
    );
    await waitForShow(t.pool, showId, 2);
    expect((await scan(showId, tickets[0].code)).body.result).toBe('ACCEPTED');
  });

  it('corpo malformado é 400 em Problem Details; código qualquer não é', async () => {
    const showId = newId();
    const invalid = [
      {},
      { showId: 'x', gate: 'A', code: 'y' },
      { showId, gate: '', code: 'y' },
      { showId, gate: 'A'.repeat(41), code: 'y' },
      { showId, gate: 'A\nB', code: 'y' },
      { showId, gate: 'A', code: '' },
      { showId, gate: 'A', code: 42 },
    ];
    for (const body of invalid) {
      const response = await gate.post('/v1/checkins', body).expect(400);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body.type).toBe('urn:lotou:problem:validation-error');
    }
  });

  it('exige token e o papel da portaria', async () => {
    const body = { showId: newId(), gate: 'A', code: 'x' };
    await t.anonymous.post('/v1/checkins', body).expect(401);
    const buyer = await t.as(['buyer']);
    await buyer.post('/v1/checkins', body).expect(403);
    const producer = await t.as(['producer']);
    await producer.post('/v1/checkins', body).expect(403);
  });

  describe('resumo do show', () => {
    it('entradas por portão e leituras recusadas', async () => {
      const { showId, producerId, tickets } = await showWithTickets(3);
      await scan(showId, tickets[0].code, 'Portão A');
      await scan(showId, tickets[1].code, 'Portão B');
      await scan(showId, tickets[2].code, 'Portão B');
      await scan(showId, tickets[2].code, 'Portão A'); // já utilizado
      await scan(showId, 'qualquer coisa', 'Portão A'); // inválido
      const expected = {
        checkedIn: 3,
        byGate: [
          { gate: 'Portão A', count: 1 },
          { gate: 'Portão B', count: 2 },
        ],
        rejected: 2,
      };

      await eventually(async () => {
        const response = await gate.get(`/v1/checkins/shows/${showId}/summary`);
        return response.body.rejected === 2;
      }, 'as recusas gravadas');
      const asGate = await gate
        .get(`/v1/checkins/shows/${showId}/summary`)
        .expect(200);
      expect(asGate.body).toEqual(expected);

      const owner = await t.as(['producer'], producerId);
      const asOwner = await owner
        .get(`/v1/checkins/shows/${showId}/summary`)
        .expect(200);
      expect(asOwner.body).toEqual(expected);
    });

    it('produtor que não é dono não vê o show; show desconhecido é 404', async () => {
      const { showId } = await showWithTickets();
      const stranger = await t.as(['producer']);
      await stranger.get(`/v1/checkins/shows/${showId}/summary`).expect(404);
      await gate.get(`/v1/checkins/shows/${newId()}/summary`).expect(404);
      const buyer = await t.as(['buyer']);
      await buyer.get(`/v1/checkins/shows/${showId}/summary`).expect(403);
    });
  });

  describe('shows da portaria', () => {
    it('hoje e os próximos dias, em ordem de início, sem os cancelados nem os antigos', async () => {
      const now = Date.now();
      const shows = {
        soon: showMessage({ startsAt: new Date(now + 2 * HOUR) }),
        running: showMessage({ startsAt: new Date(now - 2 * HOUR) }),
        nextWeek: showMessage({ startsAt: new Date(now + 6 * 24 * HOUR) }),
        tooFar: showMessage({ startsAt: new Date(now + 30 * 24 * HOUR) }),
        lastWeek: showMessage({ startsAt: new Date(now - 7 * 24 * HOUR) }),
        cancelled: showMessage({
          startsAt: new Date(now + 3 * HOUR),
          status: 'CANCELLED',
        }),
      };
      for (const show of Object.values(shows)) {
        await sender.catalog(show);
      }
      for (const show of Object.values(shows)) {
        await waitForShow(t.pool, show.payload.showId);
      }

      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const response: {
          body: { items: { showId: string }[]; nextCursor: string | null };
        } = await gate
          .get(`/v1/checkins/shows?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
          .expect(200);
        ids.push(...response.body.items.map((s) => s.showId));
        cursor = response.body.nextCursor;
      } while (cursor);

      const position = (show: { payload: { showId: string } }) =>
        ids.indexOf(show.payload.showId);
      expect(position(shows.running)).toBeGreaterThanOrEqual(0);
      expect(position(shows.soon)).toBeGreaterThan(position(shows.running));
      expect(position(shows.nextWeek)).toBeGreaterThan(position(shows.soon));
      expect(position(shows.tooFar)).toBe(-1);
      expect(position(shows.lastWeek)).toBe(-1);
      expect(position(shows.cancelled)).toBe(-1);

      const page = await gate.get('/v1/checkins/shows?limit=100').expect(200);
      const soon = page.body.items.find(
        (s: { showId: string }) => s.showId === shows.soon.payload.showId,
      );
      expect(soon).toEqual({
        showId: shows.soon.payload.showId,
        title: shows.soon.payload.title,
        artist: shows.soon.payload.artist,
        startsAt: shows.soon.payload.startsAt,
        timezone: 'America/Sao_Paulo',
        doorsOpenAt: shows.soon.payload.doorsOpenAt,
        venueName: 'Teatro Guanabara',
      });
    });

    it('só a portaria lista os shows', async () => {
      const producer = await t.as(['producer']);
      await producer.get('/v1/checkins/shows').expect(403);
    });
  });

  async function ticketStatusIs(ticketId: string, status: string) {
    const { rows } = await t.pool.query(
      'SELECT status FROM valid_tickets WHERE ticket_id = $1',
      [ticketId],
    );
    return rows[0]?.status === status;
  }
});
