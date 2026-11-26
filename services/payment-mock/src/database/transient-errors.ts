/**
 * Erros de infraestrutura que passam sozinhos: o Postgres reiniciando, a rede
 * caindo, o pool sem conexão livre. Uma mensagem que falha por um deles não
 * tem defeito, então não vai para a DLT: é tentada de novo até a
 * infraestrutura voltar.
 */

/** Códigos de erro do Postgres (SQLSTATE) que indicam falha passageira. */
const TRANSIENT_SQLSTATE_CLASSES = ['08']; // connection exception
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

/** Códigos de erro de rede do Node. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
]);

/** Mensagens do driver `pg` sem código próprio. */
const TRANSIENT_MESSAGES = [
  /timeout exceeded when trying to connect/i,
  /Connection terminated/i,
  /Client has encountered a connection error/i,
];

export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (
      TRANSIENT_SQLSTATES.has(code) ||
      TRANSIENT_NETWORK_CODES.has(code) ||
      TRANSIENT_SQLSTATE_CLASSES.some(
        (prefix) => code.length === 5 && code.startsWith(prefix),
      )
    ) {
      return true;
    }
  }
  if (TRANSIENT_MESSAGES.some((pattern) => pattern.test(error.message))) {
    return true;
  }
  // Um AggregateError (vários endereços recusados) é passageiro se todos forem.
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.every(isTransientError);
  }
  return false;
}
