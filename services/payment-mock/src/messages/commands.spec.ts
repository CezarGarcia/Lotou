import {
  contractErrors,
  contractExample,
} from '../../test/support/contracts.js';
import { PoisonMessageError } from '../common/errors.js';
import { parseMessage } from './commands.js';

const TOPIC = 'payment.commands';
const authorize = () => contractExample(TOPIC, 'AuthorizePayment');
const refund = () => contractExample(TOPIC, 'RefundPayment');
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('parseMessage', () => {
  it('lê o exemplo de AuthorizePayment do contrato', () => {
    const example = authorize();
    expect(parseMessage(bytes(example))).toEqual({
      kind: 'command',
      command: {
        type: 'AuthorizePayment',
        eventId: example.eventId,
        occurredAt: example.occurredAt,
        payload: example.payload,
      },
    });
  });

  it('lê o exemplo de RefundPayment do contrato', () => {
    const example = refund();
    expect(parseMessage(bytes(example))).toMatchObject({
      kind: 'command',
      command: { type: 'RefundPayment', payload: example.payload },
    });
  });

  it('ignora campos que o contrato ainda não tinha (campo novo opcional)', () => {
    const example = authorize();
    example.payload.installments = 3;
    example.traceHint = 'x';
    expect(contractErrors(TOPIC, example)).not.toEqual([]);

    const parsed = parseMessage(bytes(example));
    expect(parsed).toMatchObject({ kind: 'command' });
    expect(
      parsed.kind === 'command' && parsed.command.payload,
    ).not.toHaveProperty('installments');
  });

  it.each([
    ['tipo novo', { type: 'CapturePayment', version: 1 }],
    ['versão nova', { type: 'AuthorizePayment', version: 2 }],
  ])('devolve %s como desconhecido, sem ler o payload', (_, change) => {
    const { eventId } = authorize();
    const example = { ...authorize(), ...change, payload: { qualquer: 1 } };
    expect(parseMessage(bytes(example))).toEqual({
      kind: 'unknown',
      eventId,
      type: change.type,
      version: change.version,
    });
  });

  it.each([
    ['vazia', null],
    ['sem bytes', Buffer.alloc(0)],
    ['que não é JSON', Buffer.from('{"eventId":')],
    ['sem envelope', bytes({ orderId: 'x' })],
    ['com eventId que não é UUID', bytes({ ...authorize(), eventId: '42' })],
    [
      'com occurredAt sem fuso',
      bytes({ ...authorize(), occurredAt: '2026-11-26T18:00:00' }),
    ],
  ])('recusa mensagem %s', (_, value) => {
    expect(() => parseMessage(value)).toThrow(PoisonMessageError);
  });

  it.each([
    ['valor negativo', { amountCents: -1 }],
    ['valor fracionado', { amountCents: 10.5 }],
    ['valor em texto', { amountCents: '32000' }],
    ['orderId inválido', { orderId: 'pedido-1' }],
    ['sem comprador', { buyerId: '' }],
  ])('recusa AuthorizePayment com %s', (_, change) => {
    const example = authorize();
    const message = { ...example, payload: { ...example.payload, ...change } };
    expect(contractErrors(TOPIC, message)).not.toEqual([]);
    expect(() => parseMessage(bytes(message))).toThrow(PoisonMessageError);
  });

  it.each([
    'RESERVATION_EXPIRED',
    'ORDER_CANCELLED',
    'TICKET_CONFLICT',
    'SHOW_CANCELLED',
  ])('aceita RefundPayment com o motivo %s do contrato', (reason) => {
    const example = refund();
    const message = { ...example, payload: { ...example.payload, reason } };
    expect(contractErrors(TOPIC, message)).toEqual([]);
    expect(parseMessage(bytes(message))).toMatchObject({
      command: { type: 'RefundPayment', payload: { reason } },
    });
  });

  it('recusa RefundPayment com motivo fora do contrato', () => {
    const example = refund();
    const message = {
      ...example,
      payload: { ...example.payload, reason: 'CHANGED_MY_MIND' },
    };
    expect(() => parseMessage(bytes(message))).toThrow(/reason/);
  });
});
