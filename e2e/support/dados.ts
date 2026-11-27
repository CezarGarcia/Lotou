import { randomInt } from 'node:crypto';

/**
 * Um CPF válido e aleatório (os dígitos verificadores são calculados). Cada
 * reserva usa um novo: o limite de 4 ingressos por CPF em cada show nunca
 * barra uma execução repetida da suíte.
 */
export function cpfAleatorio(): string {
  const digitos = Array.from({ length: 9 }, () => randomInt(10));
  for (const tamanho of [9, 10]) {
    const soma = digitos
      .slice(0, tamanho)
      .reduce((total, digito, i) => total + digito * (tamanho + 1 - i), 0);
    digitos.push(((soma * 10) % 11) % 10);
  }
  return digitos.join('');
}

/**
 * Um código de cupom que ainda não existe: prefixo, instante em base 36 e um
 * sufixo aleatório, no formato que a loja aceita (letras, números e hífen).
 */
export function codigoDeCupom(prefixo: string): string {
  const instante = Date.now().toString(36);
  const sufixo = randomInt(36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${prefixo}-${instante}-${sufixo}`.toUpperCase().slice(0, 30);
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Centavos como a loja mostra: `4500` vira `R$ 45,00` (com o espaço sem quebra). */
export function brl(centavos: number): string {
  return BRL.format(centavos / 100);
}

/** O mesmo texto, pronto para um `RegExp` (o `$` e a vírgula escapados). */
export function brlRegex(centavos: number): string {
  return brl(centavos).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A data de hoje no fuso dos locais do seed (UTC-3), como DD/MM. */
export function hojeNoFusoDoSeed(): string {
  const local = new Date(Date.now() - 3 * 3_600_000).toISOString();
  return `${local.slice(8, 10)}/${local.slice(5, 7)}`;
}
