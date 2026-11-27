import { planCancellation } from './cancellation-plan.js';
import { canTransition, TICKET_STATUSES } from './ticket-status.js';

describe('estados do ingresso', () => {
  it.each([
    ['VALID', 'USED', true],
    ['VALID', 'CANCELLED', true],
    ['USED', 'CANCELLED', false],
    ['USED', 'VALID', false],
    ['CANCELLED', 'VALID', false],
    ['CANCELLED', 'USED', false],
  ] as const)('%s -> %s: %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });

  it('USED e CANCELLED são finais', () => {
    for (const to of TICKET_STATUSES) {
      expect(canTransition('USED', to)).toBe(false);
      expect(canTransition('CANCELLED', to)).toBe(false);
    }
  });
});

describe('planCancellation', () => {
  it('cancela os válidos, ignora os já cancelados e recusa o usado', () => {
    const plan = planCancellation(
      ['a', 'b', 'c', 'd'],
      new Map([
        ['a', 'VALID'],
        ['b', 'CANCELLED'],
        ['c', 'USED'],
      ]),
    );
    expect(plan).toEqual({
      cancel: ['a'],
      alreadyCancelled: ['b'],
      refused: [{ ticketId: 'c', status: 'USED' }],
      missing: ['d'],
    });
  });

  it('ID repetido na mensagem conta uma vez', () => {
    expect(
      planCancellation(['a', 'a'], new Map([['a', 'VALID']])).cancel,
    ).toEqual(['a']);
  });
});
