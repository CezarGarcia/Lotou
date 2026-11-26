/**
 * Forma de busca de um texto: sem acentos, minúsculo e com espaços simples.
 * "  São  Paulo " e "sao paulo" viram a mesma chave.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Escapa um texto para uso literal dentro de uma expressão regular. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
