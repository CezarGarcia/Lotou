/**
 * Valor em reais digitado pelo usuário para centavos, sem passar por
 * ponto flutuante: `"30"`, `"30,5"`, `"1.234,56"` e `"R$ 30,00"` viram
 * `3000`, `3050`, `123456` e `3000`. Devolve `null` quando o texto não é um
 * valor em reais (letras, mais de dois decimais, negativo, vazio).
 *
 * Aceita o ponto como separador de milhar (o jeito brasileiro) e, sem
 * vírgula, também como decimal quando vem seguido de um ou dois dígitos
 * (`"30.5"`), que é o que um teclado numérico de celular costuma produzir.
 */
export function parseBrlToCents(text: string | null | undefined): number | null {
  const value = (text ?? '').replace(/^\s*R\$\s*/i, '').trim();
  if (value === '') {
    return null;
  }
  let integer: string;
  let fraction = '';
  const brazilian = /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/.exec(value);
  const dotDecimal = /^(\d+)\.(\d{1,2})$/.exec(value);
  if (brazilian) {
    integer = brazilian[1].replace(/\./g, '');
    fraction = brazilian[2] ?? '';
  } else if (dotDecimal) {
    integer = dotDecimal[1];
    fraction = dotDecimal[2];
  } else {
    return null;
  }
  const cents = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Centavos para o texto de um campo de valor: `3050` vira `"30,50"`. */
export function centsToBrlInput(cents: number): string {
  const reais = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `${reais},${String(rest).padStart(2, '0')}`;
}
