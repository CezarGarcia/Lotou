export interface RetryPolicy {
  /** Tentativas antes da DLT, contando a primeira. */
  maxAttempts: number;
  /** Espera depois da primeira falha; dobra a cada tentativa. */
  initialBackoffMs: number;
  /** Teto da espera entre tentativas. */
  maxBackoffMs: number;
  /**
   * Quanto tempo insistir, dentro de uma entrega, numa falha passageira
   * (Postgres fora, por exemplo). Passado isso, a mensagem volta ao Kafka sem
   * confirmar e é entregue de novo, sem ir para a DLT. O limite fica bem abaixo
   * do `max.poll.interval.ms` (5 min), para o consumidor não sair do grupo.
   */
  transientBudgetMs: number;
}

export const DEFAULT_MAX_BACKOFF_MS = 5_000;
export const DEFAULT_TRANSIENT_BUDGET_MS = 60_000;

/** Backoff exponencial: 200, 400, 800, ... ms, até o teto. */
export function retryDelayMs(
  attempt: number,
  { initialBackoffMs, maxBackoffMs }: RetryPolicy,
): number {
  return Math.min(initialBackoffMs * 2 ** (attempt - 1), maxBackoffMs);
}
