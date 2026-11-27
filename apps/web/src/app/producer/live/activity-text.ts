import { formatCents } from '../../core/format/money.pipe';
import { formatInTimezone } from '../../core/format/show-date.pipe';
import { ActivityEntry } from './live.protocol';

/** Motivos de cancelamento que o order-service publica, em palavras simples. */
const CANCEL_REASONS: Record<string, string> = {
  PAYMENT_DECLINED: 'pagamento recusado',
  RESERVATION_EXPIRED: 'reserva expirou',
  TICKET_CONFLICT: 'cadeira vendida no mesmo instante',
};

const tickets = (quantity: number) => (quantity === 1 ? '1 ingresso' : `${quantity} ingressos`);

/**
 * "2º lote em Pista". Setor e lote podem faltar quando o lote chega ao
 * analytics antes do show: o texto fica neutro em vez de mostrar "null".
 */
const lotIn = (lotName: string | null, sectorName: string | null) =>
  `${lotName ?? 'Lote'} em ${sectorName ?? 'um setor'}`;

/** Ícone e tom de cada tipo de entrada no feed. */
export const ACTIVITY_ICONS: Record<ActivityEntry['type'], string> = {
  OrderConfirmed: 'shopping_bag',
  OrderCancelled: 'remove_shopping_cart',
  LotOpened: 'lock_open',
  LotSoldOut: 'block',
};

export interface ActivityText {
  title: string;
  detail: string;
}

/** O que a entrada diz, em português: título curto e o detalhe. */
export function describeActivity(entry: ActivityEntry): ActivityText {
  switch (entry.type) {
    case 'OrderConfirmed':
      return {
        title: 'Pedido confirmado',
        detail: `${tickets(entry.quantity)} em ${entry.sectorName} · ${formatCents(entry.totalCents)}`,
      };
    case 'OrderCancelled': {
      const reason = CANCEL_REASONS[entry.reason];
      return {
        title: 'Pedido cancelado',
        detail: reason
          ? `${reason} · ${formatCents(entry.totalCents)}`
          : formatCents(entry.totalCents),
      };
    }
    case 'LotOpened':
      return {
        title: 'Lote aberto',
        detail: `${lotIn(entry.lotName, entry.sectorName)} · ${formatCents(entry.priceCents)}`,
      };
    case 'LotSoldOut':
      return { title: 'Lote esgotado', detail: lotIn(entry.lotName, entry.sectorName) };
  }
}

/** A entrada numa frase só, para o anúncio dos leitores de tela. */
export function activitySentence(entry: ActivityEntry): string {
  const { title, detail } = describeActivity(entry);
  return `${title}: ${detail.replace(/ · /g, ', ')}.`;
}

/**
 * Quanto tempo atrás, em português: "agora", "há 12 s", "há 3 min", "há 2 h".
 * Depois de um dia, a data e a hora no fuso do show.
 */
export function relativeTime(instant: string, now: number, timezone?: string): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(instant)) / 1000));
  if (seconds < 5) {
    return 'agora';
  }
  if (seconds < 60) {
    return `há ${seconds} s`;
  }
  if (seconds < 3_600) {
    return `há ${Math.floor(seconds / 60)} min`;
  }
  if (seconds < 86_400) {
    return `há ${Math.floor(seconds / 3_600)} h`;
  }
  return formatInTimezone(instant, timezone, 'short');
}

/** Um anúncio para várias entradas novas: a contagem e a mais recente. */
export function announcement(count: number, newest: ActivityEntry | null): string {
  if (count <= 0 || !newest) {
    return '';
  }
  const sentence = activitySentence(newest);
  return count === 1 ? sentence : `${count} novas atividades. A mais recente: ${sentence}`;
}
