import {
  CHECKIN_RESULTS,
  evaluate,
  RESULT_COLORS,
  type ScannedTicket,
  toResponse,
} from './checkin-result.js';

const SHOW = '01a21a00-0000-7000-8000-000000000001';
const NOW = new Date('2026-12-16T22:30:00Z');

const ticket = (changes: Partial<ScannedTicket> = {}): ScannedTicket => ({
  ticketId: '01a21a00-0000-7000-8000-000000000013',
  orderId: '01a21a00-0000-7000-8000-000000000010',
  showId: SHOW,
  sectorId: '01a21a00-0000-7000-8000-000000000004',
  sectorName: 'Plateia',
  seat: 'A-5',
  status: 'VALID',
  show: {
    startsAt: new Date('2026-12-16T23:30:00Z'),
    doorsOpenAt: new Date('2026-12-16T22:00:00Z'),
    timezone: 'America/Sao_Paulo',
  },
  entry: null,
  ...changes,
});

describe('evaluate', () => {
  it('ingresso válido, do show, com os portões abertos: falta só a corrida', () => {
    expect(evaluate(ticket(), SHOW, NOW)).toEqual({ result: 'ELIGIBLE' });
  });

  it('desconhecido', () => {
    expect(evaluate(undefined, SHOW, NOW).result).toBe('UNKNOWN_TICKET');
  });

  it('de outro show', () => {
    expect(
      evaluate(ticket(), '01a21a00-0000-7000-8000-000000000099', NOW).result,
    ).toBe('WRONG_SHOW');
  });

  it('cancelado', () => {
    expect(evaluate(ticket({ status: 'CANCELLED' }), SHOW, NOW).result).toBe(
      'CANCELLED',
    );
  });

  it('já usado', () => {
    expect(evaluate(ticket({ status: 'USED' }), SHOW, NOW).result).toBe(
      'ALREADY_USED',
    );
  });

  it('antes da abertura dos portões', () => {
    const early = new Date('2026-12-16T21:59:00Z');
    expect(evaluate(ticket(), SHOW, early).result).toBe('NOT_OPEN');
  });

  it('confere na ordem: outro show vem antes de cancelado e de fechado', () => {
    const early = new Date('2026-12-16T21:00:00Z');
    const other = '01a21a00-0000-7000-8000-000000000099';
    expect(evaluate(ticket({ status: 'CANCELLED' }), other, early).result).toBe(
      'WRONG_SHOW',
    );
    expect(evaluate(ticket({ status: 'CANCELLED' }), SHOW, early).result).toBe(
      'CANCELLED',
    );
  });

  it('sem o show na cópia local, não barra pela abertura dos portões', () => {
    expect(evaluate(ticket({ show: null }), SHOW, NOW).result).toBe('ELIGIBLE');
  });
});

describe('toResponse', () => {
  const entry = { at: new Date('2026-12-16T23:31:00Z'), gate: 'Portão B' };

  it('liberado: o ingresso, sem primeira entrada', () => {
    expect(toResponse('ACCEPTED', ticket(), entry)).toEqual({
      result: 'ACCEPTED',
      ticket: {
        ticketId: '01a21a00-0000-7000-8000-000000000013',
        sectorName: 'Plateia',
        seat: 'A-5',
      },
      firstEntry: null,
    });
  });

  it('já utilizado: horário em UTC e portão da primeira entrada', () => {
    expect(toResponse('ALREADY_USED', ticket(), entry).firstEntry).toEqual({
      at: '2026-12-16T23:31:00.000Z',
      gate: 'Portão B',
    });
  });

  it('código inválido: nada sobre o ingresso', () => {
    expect(toResponse('INVALID_CODE')).toEqual({
      result: 'INVALID_CODE',
      ticket: null,
      firstEntry: null,
    });
  });

  it('pista: cadeira nula', () => {
    expect(toResponse('CANCELLED', ticket({ seat: null })).ticket?.seat).toBe(
      null,
    );
  });

  it('as três cores do leitor', () => {
    const withColor = (color: string) =>
      CHECKIN_RESULTS.filter((result) => RESULT_COLORS[result] === color);
    expect({
      green: withColor('green'),
      yellow: withColor('yellow'),
      red: withColor('red'),
    }).toEqual({
      green: ['ACCEPTED'],
      yellow: ['ALREADY_USED'],
      red: [
        'INVALID_CODE',
        'UNKNOWN_TICKET',
        'CANCELLED',
        'WRONG_SHOW',
        'NOT_OPEN',
      ],
    });
  });
});
