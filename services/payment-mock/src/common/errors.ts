/**
 * Erro que não passa com uma nova tentativa: a mensagem vai direto para a DLT.
 * Exemplos: JSON inválido, payload fora do contrato, transição de estado fora
 * da tabela.
 */
export class NonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A mensagem não é um comando válido: JSON quebrado ou fora do contrato. */
export class PoisonMessageError extends NonRetryableError {}
