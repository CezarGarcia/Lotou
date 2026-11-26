import { ApiError } from '../../core/http/problem';

/** Um erro de compra pronto para a tela. */
export interface PurchaseError {
  message: string;
  traceId?: string;
}

/** "A-1", "A-1 e A-2", "A-1, A-2 e A-3". */
export function listPt(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

const asNumber = (value: unknown) => (typeof value === 'number' ? value : undefined);

const asStrings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const tickets = (count: number) => (count === 1 ? '1 ingresso' : `${count} ingressos`);

/**
 * A mensagem para o comprador quando uma reserva ou um pedido falha. Os erros
 * de negócio chegam como Problem Details com `type` `urn:lotou:problem:<tipo>`;
 * o texto usa os membros de extensão (quantos restam, quais cadeiras).
 */
export function purchaseErrorMessage(error: ApiError): string {
  const details = error.details ?? {};
  switch (error.code) {
    case 'sold-out':
      return 'Os ingressos deste setor esgotaram.';
    case 'insufficient-stock': {
      const available = asNumber(details['available']);
      if (available === undefined) {
        return 'Não há ingressos suficientes neste lote. Diminua a quantidade.';
      }
      return available === 0
        ? 'Os ingressos deste lote acabaram.'
        : `${available === 1 ? 'Só resta' : 'Só restam'} ${tickets(available)} neste lote. Diminua a quantidade e tente de novo.`;
    }
    case 'seat-unavailable': {
      const seats = asStrings(details['seats']);
      if (seats.length === 0) {
        return 'Uma das cadeiras escolhidas acabou de ser reservada por outra pessoa. Escolha outra.';
      }
      return seats.length === 1
        ? `A cadeira ${seats[0]} acabou de ser reservada por outra pessoa. Escolha outra.`
        : `As cadeiras ${listPt(seats)} acabaram de ser reservadas por outra pessoa. Escolha outras.`;
    }
    case 'seat-not-found':
      return 'Uma das cadeiras escolhidas não existe neste setor. Atualize a página e escolha de novo.';
    case 'purchase-limit-exceeded': {
      const remaining = asNumber(details['remaining']);
      if (remaining === undefined || remaining <= 0) {
        return 'Este CPF já chegou ao limite de 4 ingressos para este show.';
      }
      return `Este CPF ainda pode comprar ${tickets(remaining)} para este show (o limite é 4 por CPF).`;
    }
    case 'sales-not-open':
      return 'As vendas deste setor ainda não abriram.';
    case 'sales-paused':
      return 'As vendas deste setor estão pausadas pelo produtor. Tente de novo daqui a pouco.';
    case 'sales-closed':
      return 'As vendas deste setor foram encerradas.';
    case 'queue-admission-required':
      return 'Este show tem fila virtual: entre na fila para comprar.';
    case 'inventory-loading':
      return 'Estamos preparando os ingressos para a abertura das vendas. Tente de novo em alguns segundos.';
    case 'rate-limited': {
      const seconds = error.retryAfterSeconds;
      return seconds
        ? `Muitas tentativas em pouco tempo. Aguarde ${seconds} ${seconds === 1 ? 'segundo' : 'segundos'} e tente de novo.`
        : 'Muitas tentativas em pouco tempo. Aguarde um pouco e tente de novo.';
    }
    case 'reservation-not-held':
      return 'Sua reserva expirou antes do pagamento, e os ingressos voltaram à venda.';
    case 'validation-error': {
      const errors = Array.isArray(details['errors'])
        ? (details['errors'] as { field?: string }[])
        : [];
      if (errors.some((item) => item.field === 'cpf')) {
        return 'O CPF informado não é válido. Confira os números.';
      }
      break;
    }
  }
  if (error.status === 401) {
    return 'Sua sessão expirou. Entre de novo para continuar.';
  }
  if (error.status === 403) {
    return 'Sua conta não pode comprar ingressos. Entre com uma conta de comprador.';
  }
  return error.message;
}
