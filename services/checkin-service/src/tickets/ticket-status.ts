/**
 * Estados do ingresso na cópia local (docs/projeto.md, "Estados"):
 *
 * - `VALID`: emitido (`TicketsIssued`), ainda não usado;
 * - `USED`: entrou no show; final;
 * - `CANCELLED`: o pedido foi cancelado ou reembolsado (`TicketsCancelled`); final.
 */
export const TICKET_STATUSES = ['VALID', 'USED', 'CANCELLED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Tabela única de transições. Toda mudança de estado passa por ela; o que não
 * está aqui é recusado. Ingresso usado não vai para `CANCELLED`: é por isso
 * que o order-service não cancela pedido com ingresso usado.
 */
export const TICKET_TRANSITIONS: Readonly<
  Record<TicketStatus, readonly TicketStatus[]>
> = {
  VALID: ['USED', 'CANCELLED'],
  USED: [],
  CANCELLED: [],
};

export const canTransition = (from: TicketStatus, to: TicketStatus): boolean =>
  TICKET_TRANSITIONS[from].includes(to);
