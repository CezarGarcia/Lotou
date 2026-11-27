import { contractExample } from '../../test/support/contracts.js';
import { PoisonMessageError } from '../common/errors.js';
import { parseMessage } from './incoming.js';

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('mensagens consumidas', () => {
  it.each([
    ['order.events', 'TicketsIssued'],
    ['order.events', 'TicketsCancelled'],
    ['shows.catalog', 'ShowPublished'],
    ['shows.catalog', 'ShowUpdated'],
  ])('lê o exemplo de %s/%s do contrato', (topic, type) => {
    const example = contractExample(topic, type);
    const parsed = parseMessage(topic, bytes(example));
    expect(parsed).toMatchObject({
      kind: 'known',
      message: { type, eventId: example.eventId },
    });
  });

  it('do TicketsIssued, guarda o que a portaria usa (e não o código do QR)', () => {
    const parsed = parseMessage(
      'order.events',
      bytes(contractExample('order.events', 'TicketsIssued')),
    );
    expect(parsed.kind === 'known' && parsed.message.payload).toMatchObject({
      orderId: '01a21a00-0000-7000-8000-000000000010',
      tickets: [
        { ticketId: '01a21a00-0000-7000-8000-000000000013', seat: 'A-5' },
        { ticketId: '01a21a00-0000-7000-8000-000000000014', seat: 'A-6' },
      ],
    });
  });

  it('do catálogo, lê o nome e o fuso do local', () => {
    const parsed = parseMessage(
      'shows.catalog',
      bytes(contractExample('shows.catalog', 'ShowUpdated')),
    );
    expect(parsed.kind === 'known' && parsed.message.payload).toMatchObject({
      version: 3,
      doorsOpenAt: '2026-12-16T22:00:00Z',
      venue: { name: 'Teatro Guanabara', timezone: 'America/Sao_Paulo' },
    });
  });

  it.each([
    ['order.events', 'OrderConfirmed'],
    ['order.events', 'OrderRefunded'],
  ])('ignora %s/%s, sem olhar o payload', (topic, type) => {
    const example = contractExample(topic, type);
    expect(
      parseMessage(topic, bytes({ ...example, payload: 'qualquer coisa' })),
    ).toEqual({ kind: 'ignored', eventId: example.eventId, type, version: 1 });
  });

  it('ignora versão que não conhece', () => {
    const example = contractExample('order.events', 'TicketsIssued');
    expect(
      parseMessage('order.events', bytes({ ...example, version: 2 })).kind,
    ).toBe('ignored');
  });

  it('o tipo vale só no tópico dele', () => {
    const example = contractExample('order.events', 'TicketsIssued');
    expect(parseMessage('shows.catalog', bytes(example)).kind).toBe('ignored');
  });

  type Example = { payload: Record<string, unknown> };
  const issued = contractExample<Example>('order.events', 'TicketsIssued');
  const updated = contractExample<Example>('shows.catalog', 'ShowUpdated');

  it.each([
    ['JSON quebrado', 'order.events', Buffer.from('{"eventId": ')],
    ['valor vazio', 'order.events', null],
    ['sem envelope', 'order.events', bytes({ type: 'TicketsIssued' })],
    [
      'TicketsIssued sem ingressos',
      'order.events',
      bytes({ ...issued, payload: { ...issued.payload, tickets: [] } }),
    ],
    [
      'show com fuso que não existe',
      'shows.catalog',
      bytes({
        ...updated,
        payload: {
          ...updated.payload,
          venue: { name: 'Lugar', timezone: 'America/Atlantida' },
        },
      }),
    ],
  ])('recusa %s como mensagem envenenada', (_, topic, value) => {
    expect(() => parseMessage(topic, value)).toThrow(PoisonMessageError);
  });
});
