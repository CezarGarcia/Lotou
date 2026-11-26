import { Pipe, PipeTransform } from '@angular/core';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Centavos (inteiro) para reais: `18000` vira `R$ 180,00`. */
export function formatCents(cents: number): string {
  return BRL.format(cents / 100);
}

/**
 * Formata um valor em centavos. Todo dinheiro do Lotou trafega como inteiro
 * em centavos; a divisão por 100 só acontece aqui, na hora de exibir.
 */
@Pipe({ name: 'brl' })
export class MoneyPipe implements PipeTransform {
  transform(cents: number | null | undefined): string {
    return cents === null || cents === undefined ? '' : formatCents(cents);
  }
}
