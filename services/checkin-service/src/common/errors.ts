/**
 * Erro que não passa com uma nova tentativa: a mensagem vai direto para a DLT.
 * Exemplo: JSON inválido ou payload fora do contrato.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A mensagem não segue o contrato: JSON quebrado ou payload inválido. */
export class PoisonMessageError extends NonRetryableError {}
