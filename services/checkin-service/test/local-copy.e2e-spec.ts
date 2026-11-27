import { newId } from '../src/common/ids.js';
import {
  type ApiClient,
  createTestApp,
  type TestApp,
  ticketStatus,
  waitForShow,
  waitForTickets,
} from './support/app.js';
import { contractExample } from './support/contracts.js';
import {
  showMessage,
  ticketsCancelled,
  ticketsIssued,
} from './support/fixtures.js';
import { EventSender, settle, TopicRecorder } from './support/kafka.js';

describe('Cópia local dos ingressos e do catálogo', () => {
  let t: TestApp;
  let sender: EventSender;
  let recorder: TopicRecorder;
  let gate: ApiClient;

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

  const scan = (showId: string, code: string) =>
    gate
      .post('/v1/checkins', { showId, gate: 'Portão A', code })
      .expect(200)
      .then((response) => response.body);

  async function snapshot() {
    const [tickets, checkins, processed] = await Promise.all([
      t.pool.query(
        'SELECT ticket_id, status, cancelled_at FROM valid_tickets ORDER BY ticket_id',
      ),
      t.pool.query('SELECT ticket_id, gate FROM checkins ORDER BY ticket_id'),
      t.pool.query('SELECT count(*)::int AS count FROM processed_events'),
    ]);
    return {
      tickets: tickets.rows,
      checkins: checkins.rows,
      processed: processed.rows[0].count,
    };
  }

  it('grava os ingressos do TicketsIssued como válidos, com setor e cadeira', async () => {
    const show = showMessage();
    const issued = ticketsIssued(show.payload.showId, 2);
    await sender.catalog(show);
    await sender.order(issued);

    const ids = issued.payload.tickets.map((ticket) => ticket.ticketId);
    await waitForTickets(t.pool, ids);
    const { rows } = await t.pool.query(
      `SELECT ticket_id, order_id, show_id, sector_name, seat, status
         FROM valid_tickets WHERE ticket_id = ANY($1::uuid[]) ORDER BY seat`,
      [ids],
    );
    expect(rows).toEqual(
      issued.payload.tickets.map((ticket) => ({
        ticket_id: ticket.ticketId,
        order_id: issued.payload.orderId,
        show_id: show.payload.showId,
        sector_name: 'Plateia',
        seat: ticket.seat,
        status: 'VALID',
      })),
    );
  });

  it('TicketsCancelled: o leitor diz CANCELLED, e o ingresso fica na cópia local', async () => {
    const show = showMessage();
    const issued = ticketsIssued(show.payload.showId, 2);
    await sender.catalog(show);
    await sender.order(issued);
    const ids = issued.payload.tickets.map((ticket) => ticket.ticketId);
    await waitForTickets(t.pool, ids);
    await waitForShow(t.pool, show.payload.showId);

    await sender.order(ticketsCancelled(issued, 'SHOW_CANCELLED'));
    await waitForTickets(t.pool, ids, 'CANCELLED');

    const result = await scan(
      show.payload.showId,
      issued.payload.tickets[0].code,
    );
    expect(result).toMatchObject({
      result: 'CANCELLED',
      ticket: { ticketId: ids[0], sectorName: 'Plateia', seat: 'A-1' },
      firstEntry: null,
    });
    const { rows } = await t.pool.query(
      'SELECT cancel_reason FROM valid_tickets WHERE ticket_id = $1',
      [ids[0]],
    );
    expect(rows[0].cancel_reason).toBe('SHOW_CANCELLED');
  });

  it('ingresso já usado não é cancelado (USED é final); os outros do pedido são', async () => {
    const show = showMessage();
    const issued = ticketsIssued(show.payload.showId, 2);
    await sender.catalog(show);
    await sender.order(issued);
    const [used, other] = issued.payload.tickets;
    await waitForTickets(t.pool, [used.ticketId, other.ticketId]);
    await waitForShow(t.pool, show.payload.showId);
    expect((await scan(show.payload.showId, used.code)).result).toBe(
      'ACCEPTED',
    );

    await sender.order(ticketsCancelled(issued));
    await waitForTickets(t.pool, [other.ticketId], 'CANCELLED');

    expect(await ticketStatus(t.pool, used.ticketId)).toBe('USED');
    expect((await scan(show.payload.showId, used.code)).result).toBe(
      'ALREADY_USED',
    );
  });

  it('mensagem repetida do Kafka não muda nada', async () => {
    const show = showMessage();
    const issued = ticketsIssued(show.payload.showId);
    const cancelled = ticketsCancelled(issued);
    await sender.catalog(show);
    await sender.order(issued);
    await sender.order(cancelled);
    const [ticket] = issued.payload.tickets;
    await waitForTickets(t.pool, [ticket.ticketId], 'CANCELLED');
    // Uma mensagem qualquer depois, para saber quando a fila andou.
    const marker = ticketsIssued(show.payload.showId);
    await sender.order({
      ...marker,
      payload: { ...marker.payload, orderId: issued.payload.orderId },
    });
    await waitForTickets(t.pool, [marker.payload.tickets[0].ticketId]);
    const before = await snapshot();

    // O mesmo TicketsIssued de novo (mesmo eventId): não ressuscita o
    // ingresso cancelado. O mesmo TicketsCancelled de novo: nada.
    await sender.order(issued);
    await sender.order(cancelled);
    // E um TicketsIssued novo (outro eventId) com o mesmo ingresso: também não.
    const reissued = { ...issued, eventId: newId() };
    await sender.order(reissued);
    const after = ticketsIssued(show.payload.showId);
    await sender.order({
      ...after,
      payload: { ...after.payload, orderId: issued.payload.orderId },
    });
    await waitForTickets(t.pool, [after.payload.tickets[0].ticketId]);

    const current = await snapshot();
    expect(current.tickets).toEqual([
      ...before.tickets,
      expect.objectContaining({
        ticket_id: after.payload.tickets[0].ticketId,
        status: 'VALID',
      }),
    ]);
    expect(current.checkins).toEqual(before.checkins);
    // Só o TicketsIssued de outro eventId e o marcador final contaram.
    expect(current.processed).toBe(before.processed + 2);
    expect(await ticketStatus(t.pool, ticket.ticketId)).toBe('CANCELLED');
  });

  it('o catálogo fica com a versão mais alta de cada show, mesmo fora de ordem', async () => {
    const showId = newId();
    const startsAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const v3 = showMessage({
      showId,
      version: 3,
      type: 'ShowUpdated',
      startsAt,
    });
    v3.payload.title = 'Versão três';
    const v2 = showMessage({
      showId,
      version: 2,
      type: 'ShowUpdated',
      startsAt,
    });
    v2.payload.title = 'Versão dois';

    await sender.catalog(v3);
    await sender.catalog(v2);
    await sender.catalog(v3);
    await waitForShow(t.pool, showId, 3);
    // O v2 depois do v3 chegou e foi ignorado: um marcador com a mesma chave
    // (mesma partição, então processado depois dele) prova.
    const marker = showMessage();
    await sender.send('shows.catalog', showId, marker);
    await waitForShow(t.pool, marker.payload.showId);

    const { rows } = await t.pool.query(
      'SELECT version, title FROM shows WHERE show_id = $1',
      [showId],
    );
    expect(rows).toEqual([{ version: 3, title: 'Versão três' }]);
  });

  it('mensagem fora do contrato vai para a DLT e o consumidor segue', async () => {
    const orderId = newId();
    await sender.send('order.events', orderId, '{"isto não é": json');
    const broken = ticketsIssued(newId());
    await sender.send('order.events', broken.payload.orderId, {
      ...broken,
      payload: { ...broken.payload, tickets: [] },
    });

    const [dead] = await recorder.waitFor('order.events.dlt', orderId);
    expect(dead.headers['dlt.error.class']).toBe('PoisonMessageError');
    await recorder.waitFor('order.events.dlt', broken.payload.orderId);

    // O consumidor seguiu: um ingresso novo chega à cópia local.
    const show = showMessage();
    const next = ticketsIssued(show.payload.showId);
    await sender.order(next);
    await waitForTickets(t.pool, [next.payload.tickets[0].ticketId]);
  });

  it('ignora os outros fatos do pedido', async () => {
    const confirmed = contractExample('order.events', 'OrderConfirmed');
    const orderId = newId();
    await sender.send('order.events', orderId, {
      ...confirmed,
      eventId: newId(),
      payload: { ...confirmed.payload, orderId },
    });
    const show = showMessage();
    const next = ticketsIssued(show.payload.showId);
    await sender.order({
      ...next,
      payload: { ...next.payload, orderId },
    });
    await waitForTickets(t.pool, [next.payload.tickets[0].ticketId]);
    await settle(200);

    expect(recorder.of('order.events.dlt', orderId)).toEqual([]);
    const { rows } = await t.pool.query(
      'SELECT type FROM processed_events WHERE type = $1',
      ['OrderConfirmed'],
    );
    expect(rows).toEqual([]);
  });
});
