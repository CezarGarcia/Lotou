import type { ScannedTicket } from './checkin-result.js';
import {
  evaluateOffline,
  inScanOrder,
  isPlausibleScanTime,
  toResult,
} from './offline-scan.js';

const SHOW = '01a21a00-0000-7000-8000-000000000001';
const NOW = new Date('2026-11-27T22:00:00Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const ticket = (overrides: Partial<ScannedTicket> = {}): ScannedTicket => ({
  ticketId: '01a21a00-0000-7000-8000-000000000013',
  orderId: '01a21a00-0000-7000-8000-000000000010',
  showId: SHOW,
  sectorId: '01a21a00-0000-7000-8000-000000000002',
  sectorName: 'Pista',
  seat: null,
  status: 'VALID',
  show: {
    startsAt: new Date('2026-11-27T23:00:00Z'),
    doorsOpenAt: new Date('2026-11-27T20:00:00Z'),
    timezone: 'America/Belem',
  },
  entry: null,
  ...overrides,
});

describe('isPlausibleScanTime', () => {
  it.each([
    ['agora', 0, true],
    ['há 47 h', -47 * HOUR, true],
    ['exatamente 48 h atrás', -48 * HOUR, true],
    ['48 h e 1 s atrás', -48 * HOUR - 1_000, false],
    ['4 min à frente (relógio adiantado)', 4 * MINUTE, true],
    ['exatamente 5 min à frente', 5 * MINUTE, true],
    ['5 min e 1 s à frente', 5 * MINUTE + 1_000, false],
    ['amanhã', 24 * HOUR, false],
  ])('%s', (_, offset, expected) => {
    expect(isPlausibleScanTime(new Date(NOW.getTime() + offset), NOW)).toBe(
      expected,
    );
  });
});

describe('inScanOrder', () => {
  it('pelo horário da leitura e, no empate, pelo ID; sem mexer na lista recebida', () => {
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);
    const scans = [
      { id: 'c', code: 'x', scannedAt: at(-1) },
      { id: 'b', code: 'x', scannedAt: at(-5) },
      { id: 'a', code: 'x', scannedAt: at(-1) },
    ];
    expect(inScanOrder(scans).map((scan) => scan.id)).toEqual(['b', 'a', 'c']);
    expect(scans.map((scan) => scan.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('evaluateOffline', () => {
  it('ingresso válido do show, sem entrada: grava', () => {
    expect(evaluateOffline(ticket(), SHOW)).toEqual({ result: 'ELIGIBLE' });
  });

  it('ingresso que a cópia local não conhece: conflito UNKNOWN', () => {
    expect(evaluateOffline(undefined, SHOW)).toEqual({
      result: 'CONFLICT',
      kind: 'UNKNOWN',
    });
  });

  it('de outro show: WRONG_SHOW, antes de olhar o estado', () => {
    expect(
      evaluateOffline(
        ticket({
          showId: '01a21a00-0000-7000-8000-000000000099',
          status: 'USED',
        }),
        SHOW,
      ),
    ).toEqual({ result: 'CONFLICT', kind: 'WRONG_SHOW' });
  });

  it('cancelado: conflito CANCELLED', () => {
    expect(evaluateOffline(ticket({ status: 'CANCELLED' }), SHOW)).toEqual({
      result: 'CONFLICT',
      kind: 'CANCELLED',
    });
  });

  it('já usado: entrada dupla, com a entrada que valeu', () => {
    const entry = { at: new Date('2026-11-27T20:40:00Z'), gate: 'Portão B' };
    expect(evaluateOffline(ticket({ status: 'USED', entry }), SHOW)).toEqual({
      result: 'DUPLICATE',
      entry,
    });
  });

  it('não confere a abertura dos portões: o aparelho já conferiu, e a pessoa entrou', () => {
    const early = ticket({
      show: {
        startsAt: new Date('2099-01-01T23:00:00Z'),
        doorsOpenAt: new Date('2099-01-01T20:00:00Z'),
        timezone: 'America/Sao_Paulo',
      },
    });
    expect(evaluateOffline(early, SHOW)).toEqual({ result: 'ELIGIBLE' });
  });
});

describe('toResult', () => {
  const base = { id: 'leitura', kind: null, reason: null, firstEntry: null };

  it('monta a resposta de cada resultado', () => {
    expect(toResult({ ...base, outcome: 'RECORDED' })).toEqual({
      id: 'leitura',
      outcome: 'RECORDED',
    });
    expect(
      toResult({
        ...base,
        outcome: 'DUPLICATE',
        kind: 'DUPLICATE',
        firstEntry: { at: new Date('2026-11-27T20:40:00Z'), gate: 'Portão B' },
      }),
    ).toEqual({
      id: 'leitura',
      outcome: 'DUPLICATE',
      firstEntry: { gate: 'Portão B', checkedInAt: '2026-11-27T20:40:00.000Z' },
    });
    expect(
      toResult({ ...base, outcome: 'CONFLICT', kind: 'CANCELLED' }),
    ).toEqual({ id: 'leitura', outcome: 'CONFLICT', kind: 'CANCELLED' });
    expect(
      toResult({ ...base, outcome: 'REJECTED', reason: 'INVALID_TIME' }),
    ).toEqual({ id: 'leitura', outcome: 'REJECTED', reason: 'INVALID_TIME' });
  });
});
