import { Pipe, PipeTransform } from '@angular/core';

const INTEGER = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

/** Quantidades com separador de milhar brasileiro: `1240` vira `1.240`. */
export function formatCount(value: number): string {
  return INTEGER.format(value);
}

/**
 * Formata contagens (ingressos, pedidos) sempre em pt-BR, como o pipe `brl`
 * faz com dinheiro, sem depender do `LOCALE_ID` de quem usa.
 */
@Pipe({ name: 'count' })
export class CountPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return value === null || value === undefined ? '' : formatCount(value);
  }
}
