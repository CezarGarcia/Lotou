import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { formatCents } from '../../core/format/money.pipe';
import { parseBrlToCents } from '../../core/format/money-input';
import { zonedLocalToUtc } from '../../core/format/zoned-time';
import { Coupon, CouponKind, CreateCoupon } from '../data/coupons.api';

/** Código do cupom: letras sem acento, números, hífen e sublinhado; de 3 a 30. */
export const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,29}$/;
export const MAX_COUPON_USES = 1_000_000;

/** Os campos do formulário, como o usuário digitou. */
export interface CouponFormValue {
  code: string;
  kind: CouponKind;
  percent: number | null;
  /** Em reais, como texto: "30,00". */
  amount: string;
  maxUses: number | null;
  /** `AAAA-MM-DDTHH:mm`, no fuso do show. */
  validUntil: string;
  sectorIds: string[];
}

/** O código como o servidor guarda: sem espaços e em maiúsculas. */
export const normalizeCode = (code: string) => code.replace(/\s+/g, '').toUpperCase();

export const couponCodeValidator: ValidatorFn = (control: AbstractControl) => {
  const code = normalizeCode(String(control.value ?? ''));
  return code === '' || COUPON_CODE_PATTERN.test(code) ? null : { couponCode: true };
};

/** Valor em reais maior que zero, com no máximo dois decimais. */
export const brlAmountValidator: ValidatorFn = (control: AbstractControl) => {
  const text = String(control.value ?? '').trim();
  if (text === '') {
    return null;
  }
  const cents = parseBrlToCents(text);
  return cents === null ? { brl: true } : cents <= 0 ? { brlMin: true } : null;
};

/** Um horário no fuso do show que ainda não passou. */
export function futureInTimezone(timezone: () => string | undefined, now = () => Date.now()) {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '');
    if (value === '') {
      return null;
    }
    const utc = zonedLocalToUtc(value, timezone() ?? 'UTC');
    if (utc === null) {
      return { dateTime: true };
    }
    return Date.parse(utc) <= now() ? { past: true } : null;
  };
}

/**
 * O corpo do `POST /coupons`, a partir do formulário já válido. O dinheiro vira
 * centavos sem ponto flutuante; a validade, UTC a partir do fuso do show.
 * `null` se algo não fecha (o formulário não deveria deixar chegar aqui).
 */
export function toCreateCoupon(
  value: CouponFormValue,
  showId: string,
  timezone: string | undefined,
): CreateCoupon | null {
  const code = normalizeCode(value.code);
  const validUntil = zonedLocalToUtc(value.validUntil, timezone ?? 'UTC');
  const maxUses = value.maxUses;
  if (!COUPON_CODE_PATTERN.test(code) || !validUntil || !maxUses || maxUses < 1) {
    return null;
  }
  const base = {
    showId,
    code,
    maxUses,
    validUntil,
    ...(value.sectorIds.length > 0 ? { sectorIds: value.sectorIds } : {}),
  };
  if (value.kind === 'PERCENT') {
    const percent = value.percent;
    return percent !== null && Number.isInteger(percent) && percent >= 1 && percent <= 100
      ? { ...base, kind: 'PERCENT', percent }
      : null;
  }
  const amountCents = parseBrlToCents(value.amount);
  return amountCents !== null && amountCents > 0 ? { ...base, kind: 'AMOUNT', amountCents } : null;
}

/** "20% de desconto" ou "R$ 30,00 de desconto por pedido". */
export function describeDiscount(coupon: Pick<Coupon, 'kind' | 'percent' | 'amountCents'>): string {
  return coupon.kind === 'PERCENT'
    ? `${coupon.percent ?? 0}% de desconto nos ingressos`
    : `${formatCents(coupon.amountCents ?? 0)} de desconto por pedido`;
}

export const COUPON_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Ativo',
  PAUSED: 'Pausado',
  EXPIRED: 'Vencido',
  EXHAUSTED: 'Esgotado',
};
