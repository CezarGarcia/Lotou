import { FormControl } from '@angular/forms';
import {
  CouponFormValue,
  brlAmountValidator,
  couponCodeValidator,
  describeDiscount,
  futureInTimezone,
  toCreateCoupon,
} from './coupon-form.model';

const value = (overrides: Partial<CouponFormValue> = {}): CouponFormValue => ({
  code: 'lancamento10',
  kind: 'PERCENT',
  percent: 10,
  amount: '',
  maxUses: 100,
  validUntil: '2026-12-31T23:59',
  sectorIds: [],
  ...overrides,
});

const errors = (validator: (c: FormControl) => unknown, input: unknown) =>
  validator(new FormControl(input));

describe('validação do cupom', () => {
  it.each(['LANCAMENTO10', 'vip-2026', 'ABC', 'A_B_C', ' amigos 10 '])(
    'aceita o código "%s"',
    (code) => {
      expect(errors(couponCodeValidator, code)).toBeNull();
    },
  );

  it.each(['AB', 'PROMOÇÃO', '-INICIO', 'TEM!', 'X'.repeat(31)])('recusa o código "%s"', (code) => {
    expect(errors(couponCodeValidator, code)).toEqual({ couponCode: true });
  });

  it('valor fixo em reais: centavos válidos, sem zero nem negativo', () => {
    expect(errors(brlAmountValidator, '30,00')).toBeNull();
    expect(errors(brlAmountValidator, '0,01')).toBeNull();
    expect(errors(brlAmountValidator, '30,555')).toEqual({ brl: true });
    expect(errors(brlAmountValidator, 'trinta')).toEqual({ brl: true });
    expect(errors(brlAmountValidator, '0,00')).toEqual({ brlMin: true });
    expect(errors(brlAmountValidator, '-5')).toEqual({ brl: true });
  });

  it('validade no fuso do show, e não no passado', () => {
    // Agora: 31/12/2026 às 23:00 em Recife (02:00 UTC do dia 1º).
    const now = () => Date.parse('2027-01-01T02:00:00Z');
    const recife = futureInTimezone(() => 'America/Recife', now);
    expect(recife(new FormControl('2026-12-31T23:30'))).toBeNull();
    expect(recife(new FormControl('2026-12-31T22:59'))).toEqual({ past: true });
    // Em Manaus (UTC-4), 22:30 ainda não chegou.
    const manaus = futureInTimezone(() => 'America/Manaus', now);
    expect(manaus(new FormControl('2026-12-31T22:30'))).toBeNull();
    expect(recife(new FormControl('amanhã'))).toEqual({ dateTime: true });
  });
});

describe('toCreateCoupon', () => {
  it('monta o percentual com o código normalizado e a validade em UTC', () => {
    expect(toCreateCoupon(value(), 's1', 'America/Recife')).toEqual({
      showId: 's1',
      code: 'LANCAMENTO10',
      kind: 'PERCENT',
      percent: 10,
      maxUses: 100,
      validUntil: '2027-01-01T02:59:00.000Z',
    });
  });

  it('valor fixo vira centavos, sem ponto flutuante', () => {
    const body = toCreateCoupon(
      value({ kind: 'AMOUNT', amount: '19,99', percent: null }),
      's1',
      'America/Recife',
    );
    expect(body).toMatchObject({ kind: 'AMOUNT', amountCents: 1_999 });
    expect(body).not.toHaveProperty('percent');
    expect(
      toCreateCoupon(value({ kind: 'AMOUNT', amount: '1.234,56' }), 's1', 'UTC'),
    ).toMatchObject({ amountCents: 123_456 });
  });

  it('manda os setores só quando escolhidos', () => {
    expect(toCreateCoupon(value({ sectorIds: ['pista'] }), 's1', 'UTC')).toMatchObject({
      sectorIds: ['pista'],
    });
    expect(toCreateCoupon(value(), 's1', 'UTC')).not.toHaveProperty('sectorIds');
  });

  it('recusa o que não fecha', () => {
    expect(toCreateCoupon(value({ percent: 0 }), 's1', 'UTC')).toBeNull();
    expect(toCreateCoupon(value({ percent: 101 }), 's1', 'UTC')).toBeNull();
    expect(toCreateCoupon(value({ percent: 12.5 }), 's1', 'UTC')).toBeNull();
    expect(toCreateCoupon(value({ maxUses: 0 }), 's1', 'UTC')).toBeNull();
    expect(toCreateCoupon(value({ kind: 'AMOUNT', amount: '0' }), 's1', 'UTC')).toBeNull();
    expect(toCreateCoupon(value({ validUntil: '' }), 's1', 'UTC')).toBeNull();
  });

  it('descreve o desconto', () => {
    expect(describeDiscount({ kind: 'PERCENT', percent: 15, amountCents: null })).toBe(
      '15% de desconto nos ingressos',
    );
    expect(
      describeDiscount({ kind: 'AMOUNT', percent: null, amountCents: 3_000 }).replace(/ /g, ' '),
    ).toBe('R$ 30,00 de desconto por pedido');
  });
});
