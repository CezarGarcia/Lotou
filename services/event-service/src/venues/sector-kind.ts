/**
 * Os dois tipos de estoque do Lotou. Cada um terá sua estratégia de reserva:
 * a pista é uma quantidade; a cadeira numerada é um item único.
 */
export const SECTOR_KINDS = ['GENERAL_ADMISSION', 'RESERVED_SEATING'] as const;
export type SectorKind = (typeof SECTOR_KINDS)[number];
