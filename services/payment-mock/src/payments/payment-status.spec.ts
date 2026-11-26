import { NonRetryableError } from '../common/errors.js';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
} from './payment-status.js';

describe('tabela de transições do pagamento', () => {
  it('só deixa estornar um pagamento aprovado', () => {
    const allowed = PAYMENT_STATUSES.flatMap((from) =>
      PAYMENT_STATUSES.filter((to) => canTransition(from, to)).map(
        (to) => `${from} -> ${to}`,
      ),
    );
    expect(allowed).toEqual(['AUTHORIZED -> REFUNDED']);
  });

  it('tem DECLINED, REFUNDED e VOIDED como finais', () => {
    expect(PAYMENT_TRANSITIONS.DECLINED).toEqual([]);
    expect(PAYMENT_TRANSITIONS.REFUNDED).toEqual([]);
    expect(PAYMENT_TRANSITIONS.VOIDED).toEqual([]);
  });

  it('recusa transição fora da tabela com um erro que vai direto à DLT', () => {
    expect(() => assertTransition('DECLINED', 'REFUNDED')).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertTransition('REFUNDED', 'AUTHORIZED')).toThrow(
      NonRetryableError,
    );
    expect(() => assertTransition('AUTHORIZED', 'REFUNDED')).not.toThrow();
  });
});
