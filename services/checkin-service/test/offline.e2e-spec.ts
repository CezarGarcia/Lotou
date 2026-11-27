import { createPublicKey, verify } from 'node:crypto';
import { newId } from '../src/common/ids.js';
import {
  type ApiClient,
  createTestApp,
  type TestApp,
  ticketStatus,
  waitForShow,
  waitForTickets,
} from './support/app.js';
import { contractErrors } from './support/contracts.js';
import {
  codeOf,
  legacyCodeOf,
  newTraceparent,
  type ShowOptions,
  showMessage,
  ticketsCancelled,
  ticketsIssued,
  traceIdOf,
} from './support/fixtures.js';
import { EventSender, TopicRecorder } from './support/kafka.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const ago = (ms: number) => new Date(Date.now() - ms);

interface ScanBody {
  id: string;
  code: string;
  scannedAt: string;
}

const read = (code: string, scannedAt: Date, id = newId()): ScanBody => ({
  id,
  code,
  scannedAt: scannedAt.toISOString(),
});

describe('Portaria offline', () => {
  let t: TestApp;
  let sender: EventSender;
  let recorder: TopicRecorder;
  let gate: ApiClient;

  /** Um show com os portões abertos e ingressos emitidos, já na cópia local. */
  async function showWithTickets(count = 1, showOptions: ShowOptions = {}) {
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
      show,
      showId: show.payload.showId as string,
      issued,
      tickets: issued.payload.tickets,
    };
  }

  /** Mais um pedido do show, cancelado. */
  async function cancelledTicket(showId: string) {
    const issued = ticketsIssued(showId);
    await sender.order(issued);
    await sender.order(ticketsCancelled(issued));
    const [ticket] = issued.payload.tickets;
    await waitForTickets(t.pool, [ticket.ticketId], 'CANCELLED');
    return ticket;
  }

  const online = (showId: string, code: string, gateName = 'Portão A') =>
    gate.post('/v1/checkins', { showId, gate: gateName, code }).expect(200);

  const sync = (
    showId: string,
    scans: ScanBody[],
    { gateName = 'Portão A', deviceId = newId() } = {},
  ) =>
    gate
      .post('/v1/checkins/offline', {
        showId,
        gate: gateName,
        deviceId,
        scans,
      })
      .expect(200);

  async function checkinsOf(ticketId: string) {
    const { rows } = await t.pool.query<{
      gate: string;
      checked_in_at: Date;
    }>('SELECT gate, checked_in_at FROM checkins WHERE ticket_id = $1', [
      ticketId,
    ]);
    return rows;
  }

  async function conflictsOf(ticketId: string) {
    const { rows } = await t.pool.query(
      `SELECT id, show_id, gate, device_id, scanned_at, kind, first_gate,
              first_checked_in_at
         FROM offline_conflicts WHERE ticket_id = $1 ORDER BY scanned_at`,
      [ticketId],
    );
    return rows;
  }

  async function checkedInEventsOf(ticketId: string) {
    const { rows } = await t.pool.query<{ payload: any }>(
      `SELECT payload FROM outbox
        WHERE type = 'TicketCheckedIn'
          AND payload -> 'payload' ->> 'ticketId' = $1`,
      [ticketId],
    );
    return rows.map((row) => row.payload);
  }

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

  describe('pacote offline', () => {
    it('todos os ingressos do show, nos três estados, com a chave pública e o horário', async () => {
      const { show, showId, tickets } = await showWithTickets(2);
      const [valid, used] = tickets;
      const cancelled = await cancelledTicket(showId);
      await online(showId, used.code, 'Portão B');
      const { rows: entry } = await t.pool.query<{ checked_in_at: Date }>(
        'SELECT checked_in_at FROM checkins WHERE ticket_id = $1',
        [used.ticketId],
      );
      // Ingressos de outro show não entram no pacote.
      await showWithTickets();

      const before = Date.now();
      const response = await gate
        .get(`/v1/checkins/shows/${showId}/offline-package`)
        .expect(200);

      const { tickets: packaged, generatedAt, ...header } = response.body;
      expect(header).toEqual({
        showId,
        publicKey: process.env.TICKET_PUBLIC_KEY,
        doorsOpenAt: show.payload.doorsOpenAt,
        startsAt: show.payload.startsAt,
        timezone: 'America/Sao_Paulo',
      });
      expect(new Date(generatedAt).getTime()).toBeGreaterThanOrEqual(
        before - 1_000,
      );
      const sector = { sectorId: valid.sectorId, sectorName: 'Plateia' };
      expect(
        [...packaged].sort((a: { id: string }, b: { id: string }) =>
          a.id.localeCompare(b.id),
        ),
      ).toEqual(
        [
          { id: valid.ticketId, ...sector, seat: 'A-1', status: 'VALID' },
          {
            id: used.ticketId,
            ...sector,
            seat: 'A-2',
            status: 'USED',
            usedAt: entry[0].checked_in_at.toISOString(),
            gate: 'Portão B',
          },
          {
            id: cancelled.ticketId,
            ...sector,
            seat: 'A-1',
            status: 'CANCELLED',
          },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      // Sem dado do pedido nem do comprador.
      expect(JSON.stringify(response.body)).not.toContain('orderId');

      // A chave do pacote confere o QR no aparelho, como o WebCrypto fará.
      const publicKey = createPublicKey({
        key: Buffer.from(response.body.publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
      const [prefix, ticketId, signature] = valid.code.split('.');
      expect(
        verify(
          null,
          Buffer.from(`${prefix}.${ticketId}`),
          publicKey,
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
    });

    it('sem abertura dos portões informada, doorsOpenAt vem nulo', async () => {
      const { showId } = await showWithTickets(1, { doorsOpenAt: null });
      const response = await gate
        .get(`/v1/checkins/shows/${showId}/offline-package`)
        .expect(200);
      expect(response.body.doorsOpenAt).toBeNull();
      expect(response.body.tickets).toHaveLength(1);
    });

    it('show fora da cópia local é 404 em Problem Details; só a portaria baixa', async () => {
      const response = await gate
        .get(`/v1/checkins/shows/${newId()}/offline-package`)
        .expect(404);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.body.type).toBe('urn:lotou:problem:not-found');

      await gate.get('/v1/checkins/shows/x/offline-package').expect(400);
      const { showId } = await showWithTickets();
      const producer = await t.as(['producer']);
      await producer
        .get(`/v1/checkins/shows/${showId}/offline-package`)
        .expect(403);
      await t.anonymous
        .get(`/v1/checkins/shows/${showId}/offline-package`)
        .expect(401);
    });
  });

  describe('envio das leituras', () => {
    it('grava a entrada com o horário da leitura, como a online: Redis, USED e TicketCheckedIn', async () => {
      const { showId, issued, tickets } = await showWithTickets();
      const [ticket] = tickets;
      const scannedAt = ago(10 * MINUTE);
      const scan = read(ticket.code, scannedAt);
      const deviceId = newId();
      const { traceparent, traceId } = newTraceparent();

      const response = await gate
        .post('/v1/checkins/offline', {
          showId,
          gate: 'Portão A',
          deviceId,
          scans: [scan],
        })
        .set('traceparent', traceparent)
        .expect(200);

      expect(response.body).toEqual({
        results: [{ id: scan.id, outcome: 'RECORDED' }],
      });
      expect(await checkinsOf(ticket.ticketId)).toEqual([
        { gate: 'Portão A', checked_in_at: scannedAt },
      ]);
      expect(await ticketStatus(t.pool, ticket.ticketId)).toBe('USED');
      expect(
        JSON.parse((await t.redis.get(`checkin:${ticket.ticketId}`))!),
      ).toEqual({ at: scannedAt.toISOString(), gate: 'Portão A' });

      const { rows: audit } = await t.pool.query(
        'SELECT * FROM offline_scans WHERE id = $1',
        [scan.id],
      );
      expect(audit).toEqual([
        expect.objectContaining({
          show_id: showId,
          gate: 'Portão A',
          device_id: deviceId,
          ticket_id: ticket.ticketId,
          scanned_at: scannedAt,
          outcome: 'RECORDED',
          kind: null,
          reason: null,
        }),
      ]);

      // O evento não muda: o mesmo TicketCheckedIn, com o horário da leitura.
      const [stored] = await checkedInEventsOf(ticket.ticketId);
      expect(stored.occurredAt).toBe(scannedAt.toISOString());
      const [event] = await recorder.waitForEvents(showId);
      expect(contractErrors('checkin.events', event.value)).toEqual([]);
      expect(event.value).toMatchObject({
        type: 'TicketCheckedIn',
        occurredAt: scannedAt.toISOString(),
        payload: {
          ticketId: ticket.ticketId,
          showId,
          orderId: issued.payload.orderId,
          sectorId: ticket.sectorId,
          gate: 'Portão A',
          checkedInAt: scannedAt.toISOString(),
        },
      });
      expect(traceIdOf(event.headers.traceparent)).toBe(traceId);

      // Depois, a leitura online vê a entrada offline.
      expect(
        (await online(showId, ticket.code, 'Portão C')).body,
      ).toMatchObject({
        result: 'ALREADY_USED',
        firstEntry: { at: scannedAt.toISOString(), gate: 'Portão A' },
      });
    });

    it('é idempotente pelo id da leitura: reenviar devolve o mesmo, sem gravar de novo', async () => {
      const { showId, tickets } = await showWithTickets(2);
      const deviceId = newId();
      const scans = [
        read(tickets[0].code, ago(3 * MINUTE)),
        read(tickets[1].code, ago(2 * MINUTE)),
        read(tickets[0].code, ago(1 * MINUTE)),
        read('qualquer coisa', ago(MINUTE)),
      ];

      const first = await sync(showId, scans, { deviceId });
      expect(first.body.results.map((r: any) => r.outcome)).toEqual([
        'RECORDED',
        'RECORDED',
        'DUPLICATE',
        'REJECTED',
      ]);
      const again = await sync(showId, scans, { deviceId });
      expect(again.body).toEqual(first.body);
      // Dois envios iguais ao mesmo tempo (o aparelho repetiu sem esperar).
      const [a, b] = await Promise.all([
        sync(showId, scans, { deviceId }),
        sync(showId, scans, { deviceId }),
      ]);
      expect(a.body).toEqual(first.body);
      expect(b.body).toEqual(first.body);

      const { rows } = await t.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM offline_scans WHERE id = ANY($1::uuid[])',
        [scans.map((scan) => scan.id)],
      );
      expect(rows[0].count).toBe(4);
      expect(await checkinsOf(tickets[0].ticketId)).toHaveLength(1);
      expect(await conflictsOf(tickets[0].ticketId)).toHaveLength(1);
      expect(await checkedInEventsOf(tickets[0].ticketId)).toHaveLength(1);
      expect(await checkedInEventsOf(tickets[1].ticketId)).toHaveLength(1);
    });

    it('dois aparelhos com o mesmo ingresso: o primeiro grava, o segundo é entrada dupla registrada', async () => {
      const { showId, tickets } = await showWithTickets();
      const [ticket] = tickets;
      const firstAt = ago(20 * MINUTE);
      const secondAt = ago(15 * MINUTE);
      const deviceA = newId();
      const deviceB = newId();

      const first = await sync(showId, [read(ticket.code, firstAt)], {
        gateName: 'Portão A',
        deviceId: deviceA,
      });
      expect(first.body.results[0].outcome).toBe('RECORDED');

      const scan = read(ticket.code, secondAt);
      const second = await sync(showId, [scan], {
        gateName: 'Portão C',
        deviceId: deviceB,
      });
      expect(second.body).toEqual({
        results: [
          {
            id: scan.id,
            outcome: 'DUPLICATE',
            firstEntry: {
              gate: 'Portão A',
              checkedInAt: firstAt.toISOString(),
            },
          },
        ],
      });
      expect(await conflictsOf(ticket.ticketId)).toEqual([
        {
          id: scan.id,
          show_id: showId,
          gate: 'Portão C',
          device_id: deviceB,
          scanned_at: secondAt,
          kind: 'DUPLICATE',
          first_gate: 'Portão A',
          first_checked_in_at: firstAt,
        },
      ]);
      expect(await checkinsOf(ticket.ticketId)).toEqual([
        { gate: 'Portão A', checked_in_at: firstAt },
      ]);
      expect(await checkedInEventsOf(ticket.ticketId)).toHaveLength(1);
    });

    it('no mesmo lote, vale a leitura mais antiga; a resposta segue a ordem do envio', async () => {
      const { showId, tickets } = await showWithTickets();
      const later = read(tickets[0].code, ago(MINUTE));
      const earlier = read(tickets[0].code, ago(5 * MINUTE));

      const response = await sync(showId, [later, earlier]);

      expect(response.body.results).toEqual([
        {
          id: later.id,
          outcome: 'DUPLICATE',
          firstEntry: { gate: 'Portão A', checkedInAt: earlier.scannedAt },
        },
        { id: earlier.id, outcome: 'RECORDED' },
      ]);
    });

    it('entrada online antes da offline: a offline é entrada dupla, com a online como a que valeu', async () => {
      const { showId, tickets } = await showWithTickets();
      const [ticket] = tickets;
      expect((await online(showId, ticket.code, 'Portão B')).body.result).toBe(
        'ACCEPTED',
      );
      const [onlineEntry] = await checkinsOf(ticket.ticketId);
      const scan = read(ticket.code, new Date());

      const response = await sync(showId, [scan], { gateName: 'Portão D' });

      expect(response.body.results).toEqual([
        {
          id: scan.id,
          outcome: 'DUPLICATE',
          firstEntry: {
            gate: 'Portão B',
            checkedInAt: onlineEntry.checked_in_at.toISOString(),
          },
        },
      ]);
      expect(await checkinsOf(ticket.ticketId)).toEqual([onlineEntry]);
      expect(await conflictsOf(ticket.ticketId)).toMatchObject([
        { kind: 'DUPLICATE', gate: 'Portão D', first_gate: 'Portão B' },
      ]);
    });

    it('cancelado, desconhecido ou de outro show: conflito registrado, sem entrada', async () => {
      const { showId } = await showWithTickets();
      const cancelled = await cancelledTicket(showId);
      const other = await showWithTickets();
      const unknownId = newId();
      const scans = [
        read(cancelled.code, ago(3 * MINUTE)),
        read(codeOf(unknownId), ago(2 * MINUTE)),
        read(other.tickets[0].code, ago(MINUTE)),
      ];

      const response = await sync(showId, scans);

      expect(response.body.results).toEqual([
        { id: scans[0].id, outcome: 'CONFLICT', kind: 'CANCELLED' },
        { id: scans[1].id, outcome: 'CONFLICT', kind: 'UNKNOWN' },
        { id: scans[2].id, outcome: 'CONFLICT', kind: 'WRONG_SHOW' },
      ]);
      for (const [ticketId, kind] of [
        [cancelled.ticketId, 'CANCELLED'],
        [unknownId, 'UNKNOWN'],
        [other.tickets[0].ticketId, 'WRONG_SHOW'],
      ]) {
        expect(await conflictsOf(ticketId)).toMatchObject([
          { kind, show_id: showId, first_gate: null },
        ]);
        expect(await checkinsOf(ticketId)).toEqual([]);
      }
      expect(await ticketStatus(t.pool, cancelled.ticketId)).toBe('CANCELLED');
      // O ingresso do outro show continua valendo lá.
      expect(
        (await online(other.showId, other.tickets[0].code)).body.result,
      ).toBe('ACCEPTED');
    });

    it('código inválido e horário fora da janela são recusados na leitura; o resto do lote entra', async () => {
      const { showId, tickets } = await showWithTickets(3);
      const code = tickets[0].code;
      const at = code.length - 20;
      const forged =
        code.slice(0, at) + (code[at] === 'A' ? 'B' : 'A') + code.slice(at + 1);
      const scans = [
        read(forged, ago(MINUTE)),
        read(tickets[1].code, new Date(Date.now() + 10 * MINUTE)),
        read(tickets[2].code, ago(49 * HOUR)),
        read(tickets[0].code, ago(2 * MINUTE)),
      ];

      const response = await sync(showId, scans);

      expect(response.body.results).toEqual([
        { id: scans[0].id, outcome: 'REJECTED', reason: 'INVALID_CODE' },
        { id: scans[1].id, outcome: 'REJECTED', reason: 'INVALID_TIME' },
        { id: scans[2].id, outcome: 'REJECTED', reason: 'INVALID_TIME' },
        { id: scans[3].id, outcome: 'RECORDED' },
      ]);
      expect(await checkinsOf(tickets[1].ticketId)).toEqual([]);
      expect(await checkinsOf(tickets[2].ticketId)).toEqual([]);
      expect(await ticketStatus(t.pool, tickets[1].ticketId)).toBe('VALID');
      const { rows } = await t.pool.query(
        `SELECT id, ticket_id, outcome, reason FROM offline_scans
          WHERE id = ANY($1::uuid[]) AND outcome = 'REJECTED'`,
        [scans.map((scan) => scan.id)],
      );
      expect(rows).toHaveLength(3);
      // A assinatura falsa não confere: o ID do código não é confiável.
      expect(rows.find((row) => row.id === scans[0].id)?.ticket_id).toBeNull();
      const { rows: conflicts } = await t.pool.query(
        'SELECT 1 FROM offline_conflicts WHERE id = ANY($1::uuid[])',
        [scans.map((scan) => scan.id)],
      );
      expect(conflicts).toEqual([]);
    });

    it('o QR antigo LOTOU1 também é aceito no envio', async () => {
      const { showId, tickets } = await showWithTickets();
      const scan = read(legacyCodeOf(tickets[0].ticketId), ago(MINUTE));
      const response = await sync(showId, [scan]);
      expect(response.body.results).toEqual([
        { id: scan.id, outcome: 'RECORDED' },
      ]);
    });

    it('corpo malformado é 400 em Problem Details', async () => {
      const showId = newId();
      const scan = read('x', new Date());
      const base = { showId, gate: 'Portão A', deviceId: newId() };
      const invalid = [
        {},
        { ...base, scans: [] },
        { ...base, deviceId: 'aparelho', scans: [scan] },
        { ...base, gate: 'A\nB', scans: [scan] },
        { ...base, scans: [{ ...scan, id: 'leitura-1' }] },
        { ...base, scans: [{ ...scan, scannedAt: '2026-11-27 20:41' }] },
        { ...base, scans: [{ ...scan, scannedAt: '2026-11-27T20:41:07' }] },
        { ...base, scans: [{ ...scan, code: '' }] },
        {
          ...base,
          scans: Array.from({ length: 501 }, () => read('x', new Date())),
        },
      ];
      for (const body of invalid) {
        const response = await gate
          .post('/v1/checkins/offline', body)
          .expect(400);
        expect(response.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(response.body.type).toBe('urn:lotou:problem:validation-error');
      }
    });

    it('exige token e o papel da portaria', async () => {
      const body = {
        showId: newId(),
        gate: 'A',
        deviceId: newId(),
        scans: [read('x', new Date())],
      };
      await t.anonymous.post('/v1/checkins/offline', body).expect(401);
      const producer = await t.as(['producer']);
      await producer.post('/v1/checkins/offline', body).expect(403);
    });
  });
});
