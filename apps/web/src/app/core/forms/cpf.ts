import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/** Só os dígitos do CPF, no máximo 11. */
export function cpfDigits(value: string): string {
  return value.replace(/\D/g, '').slice(0, 11);
}

/** Aplica a máscara `000.000.000-00` ao que já foi digitado. */
export function formatCpf(value: string): string {
  const digits = cpfDigits(value);
  return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)]
    .filter((part) => part !== '')
    .join('.')
    .concat(digits.length > 9 ? `-${digits.slice(9)}` : '');
}

/** Dígito verificador sobre os `length` primeiros dígitos (pesos de length + 1 até 2). */
function checkDigit(digits: string, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += Number(digits[i]) * (length + 1 - i);
  }
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
}

/**
 * Confere os dois dígitos verificadores. Sequências repetidas (`111.111.111-11`)
 * passam na conta, mas não são CPFs válidos.
 */
export function isValidCpf(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) {
    return false;
  }
  return (
    checkDigit(digits, 9) === Number(digits[9]) && checkDigit(digits, 10) === Number(digits[10])
  );
}

/**
 * Validador de formulário: `required` cuida do campo vazio; com 11 dígitos,
 * `cpf` aponta dígito verificador errado; com menos, `cpfIncomplete`.
 */
export const cpfValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value = String(control.value ?? '');
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) {
    return null;
  }
  if (digits.length < 11) {
    return { cpfIncomplete: true };
  }
  return isValidCpf(value) ? null : { cpf: true };
};
