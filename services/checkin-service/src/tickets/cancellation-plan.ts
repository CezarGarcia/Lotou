import { canTransition, type TicketStatus } from './ticket-status.js';

export interface CancellationPlan {
  /** `VALID` → `CANCELLED`. */
  cancel: string[];
  /** Já cancelados: nada a fazer. */
  alreadyCancelled: string[];
  /**
   * Transição fora da tabela (`USED` → `CANCELLED`): recusada, o ingresso
   * continua usado. Acontece se o cancelamento cruza com a entrada no portão.
   */
  refused: { ticketId: string; status: TicketStatus }[];
  /** Não estão na cópia local (o `TicketsIssued` não chegou ou foi para a DLT). */
  missing: string[];
}

/**
 * Decide, ingresso a ingresso, o que um `TicketsCancelled` muda. Os outros
 * ingressos do pedido são cancelados mesmo que um deles seja recusado: mandar
 * a mensagem inteira para a DLT deixaria entrar quem pediu o reembolso.
 */
export function planCancellation(
  ticketIds: readonly string[],
  current: ReadonlyMap<string, TicketStatus>,
): CancellationPlan {
  const plan: CancellationPlan = {
    cancel: [],
    alreadyCancelled: [],
    refused: [],
    missing: [],
  };
  for (const ticketId of new Set(ticketIds)) {
    const status = current.get(ticketId);
    if (status === undefined) {
      plan.missing.push(ticketId);
    } else if (status === 'CANCELLED') {
      plan.alreadyCancelled.push(ticketId);
    } else if (canTransition(status, 'CANCELLED')) {
      plan.cancel.push(ticketId);
    } else {
      plan.refused.push({ ticketId, status });
    }
  }
  return plan;
}
