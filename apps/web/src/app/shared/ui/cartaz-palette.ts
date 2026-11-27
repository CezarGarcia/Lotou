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

/**
 * Semente misturada ao nome antes do hash. Qualquer valor espalha os
 * artistas pelas seis tintas; este foi escolhido para os seis artistas do seed
 * saírem com as cores do protótipo aprovado, todas diferentes.
 */
const SEED = '890:';

/** Um número estável a partir de um texto (FNV-1a com uma mistura final). */
export function stableHash(text: string): number {
  let value = 0x811c9dc5;
  for (const char of text) {
    value ^= char.codePointAt(0)!;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value >>> 0;
}

/** A tinta do cartaz de um artista: o mesmo artista, a mesma cor. */
export function cartazPalette(seed: string): CartazPalette {
  return CARTAZ_PALETTES[stableHash(SEED + seed) % CARTAZ_PALETTES.length];
}
