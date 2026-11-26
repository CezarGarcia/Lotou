import {
  canTransition,
  SHOW_STATUSES,
  SHOW_TRANSITIONS,
  type ShowStatus,
} from './show-status.js';

describe('transições do show', () => {
  const allowed: [ShowStatus, ShowStatus][] = [
    ['DRAFT', 'PUBLISHED'],
    ['PUBLISHED', 'ON_SALE'],
    ['PUBLISHED', 'CANCELLED'],
    ['ON_SALE', 'SALES_CLOSED'],
    ['ON_SALE', 'CANCELLED'],
    ['SALES_CLOSED', 'FINISHED'],
  ];

  it.each(allowed)('permite %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('recusa qualquer transição fora da tabela', () => {
    const isAllowed = (from: ShowStatus, to: ShowStatus) =>
      allowed.some(([f, t]) => f === from && t === to);

    for (const from of SHOW_STATUSES) {
      for (const to of SHOW_STATUSES) {
        expect(canTransition(from, to)).toBe(isAllowed(from, to));
      }
    }
  });

  it('FINISHED e CANCELLED são finais', () => {
    expect(SHOW_TRANSITIONS.FINISHED).toEqual([]);
    expect(SHOW_TRANSITIONS.CANCELLED).toEqual([]);
  });
});
