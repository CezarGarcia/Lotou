/**
 * As tintas dos cartazes. Os shows do seed não têm foto, então cada show vira
 * um cartaz de lambe-lambe em duas cores: o fundo e a tinta das letras.
 * Todos os pares passam no contraste AA para texto grande.
 */
export interface CartazPalette {
  /** Nome da tinta, para testes e para `data-tinta`. */
  readonly name: string;
  readonly background: string;
  readonly ink: string;
}

export const CARTAZ_PALETTES: readonly CartazPalette[] = [
  { name: 'rosa', background: '#FF4D8D', ink: '#121015' },
  { name: 'verde', background: '#1F8A62', ink: '#FFE8F1' },
  { name: 'ceu', background: '#59C3FF', ink: '#0E1A3A' },
  { name: 'laranja', background: '#FF7A1A', ink: '#1A1240' },
  { name: 'lilas', background: '#B6A4FF', ink: '#16121F' },
  { name: 'amarelo', background: '#FFD23F', ink: '#121015' },
];

/** Um número estável a partir de um texto: o mesmo artista, a mesma cor. */
export function stableHash(text: string): number {
  let value = 7;
  for (const char of text) {
    value = (value * 31 + char.codePointAt(0)!) >>> 0;
  }
  return value;
}

/** A tinta do cartaz de um artista. */
export function cartazPalette(seed: string): CartazPalette {
  return CARTAZ_PALETTES[stableHash(seed) % CARTAZ_PALETTES.length];
}
