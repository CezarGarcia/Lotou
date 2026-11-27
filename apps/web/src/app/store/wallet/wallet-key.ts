/**
 * Onde a carteira de ingressos fica no localStorage (ADR 37). Num arquivo
 * próprio para o cabeçalho apagá-la no logout sem carregar a carteira inteira
 * no pacote inicial.
 */
export const WALLET_KEY = 'lotou.ingressos-salvos';

/** Apaga os ingressos salvos neste aparelho. */
export function clearSavedTickets(storage: Storage | undefined): void {
  try {
    storage?.removeItem(WALLET_KEY);
  } catch {
    // Sem acesso ao armazenamento: não havia nada salvo.
  }
}
