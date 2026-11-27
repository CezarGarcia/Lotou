import { formatInTimezone } from '../../core/format/show-date.pipe';
import { CheckinResponse, CheckinTicket } from '../data/checkin.api';

/** A cor da tela: verde libera, amarelo já entrou, vermelho barra. */
export type ScanTone = 'ok' | 'warn' | 'error';

/** O que a tela cheia mostra depois de uma leitura. */
export interface ScanView {
  tone: ScanTone;
  icon: string;
  title: string;
  detail: string;
  /** Setor e lugar, quando o ingresso é conhecido. */
  place: string;
}

/** "Plateia · Cadeira A-5" ou só "Pista". */
export function placeOf(ticket: CheckinTicket | null | undefined): string {
  if (!ticket?.sectorName) {
    return '';
  }
  return ticket.seat ? `${ticket.sectorName} · Cadeira ${ticket.seat}` : ticket.sectorName;
}

/** "às 20:31" no mesmo dia; "em 15/12 às 20:31" em outro (no fuso do show). */
function when(instant: string, timezone: string | undefined, now: number): string {
  const time = formatInTimezone(instant, timezone, 'time');
  const day = formatInTimezone(instant, timezone, 'date');
  const today = formatInTimezone(new Date(now), timezone, 'date');
  return day === today ? `às ${time}` : `em ${day.slice(0, 5)} às ${time}`;
}

/**
 * Traduz o resultado do check-in para a tela da portaria. Função pura: o fuso
 * e o relógio entram como parâmetros, para os horários saírem no fuso do show
 * (é o horário que o público e o produtor conhecem).
 */
export function describeCheckin(
  response: CheckinResponse,
  options: { timezone?: string; doorsOpenAt?: string | null; now?: number } = {},
): ScanView {
  const { timezone, doorsOpenAt, now = Date.now() } = options;
  const place = placeOf(response.ticket);
  switch (response.result) {
    case 'ACCEPTED':
      return {
        tone: 'ok',
        icon: 'check_circle',
        title: 'Entrada liberada',
        detail: '',
        place,
      };
    case 'ALREADY_USED': {
      const first = response.firstEntry;
      return {
        tone: 'warn',
        icon: 'history',
        title: 'Ingresso já utilizado',
        detail: first
          ? `Entrou ${when(first.at, timezone, now)} pelo ${first.gate}.`
          : 'Este ingresso já entrou no show.',
        place,
      };
    }
    case 'INVALID_CODE':
      return {
        tone: 'error',
        icon: 'qr_code_2',
        title: 'QR code inválido',
        detail: 'Este código não é um ingresso do Lotou, ou foi alterado.',
        place,
      };
    case 'UNKNOWN_TICKET':
      return {
        tone: 'error',
        icon: 'help',
        title: 'Ingresso não encontrado',
        detail:
          'O código parece certo, mas o ingresso não está na lista. Encaminhe ao atendimento.',
        place,
      };
    case 'CANCELLED':
      return {
        tone: 'error',
        icon: 'block',
        title: 'Ingresso cancelado',
        detail: 'O pedido foi cancelado ou reembolsado. Este ingresso não vale para a entrada.',
        place,
      };
    case 'WRONG_SHOW':
      return {
        tone: 'error',
        icon: 'event_busy',
        title: 'Ingresso de outro show',
        detail: 'Confira o show e a data no ingresso.',
        place,
      };
    case 'NOT_OPEN':
      return {
        tone: 'error',
        icon: 'door_front',
        title: 'Portões ainda fechados',
        detail: doorsOpenAt
          ? `A entrada abre ${when(doorsOpenAt, timezone, now)}.`
          : 'A entrada ainda não foi aberta.',
        place,
      };
    default:
      return {
        tone: 'error',
        icon: 'error',
        title: 'Entrada não liberada',
        detail: 'O sistema não reconheceu o resultado. Encaminhe ao atendimento.',
        place,
      };
  }
}

/** A leitura não chegou ao servidor (rede, servidor fora do ar). */
export function connectionFailure(message: string): ScanView {
  return {
    tone: 'error',
    icon: 'wifi_off',
    title: 'Não foi possível validar',
    detail: `${message} Leia o ingresso de novo.`,
    place: '',
  };
}

/**
 * A primeira tentativa chegou ao servidor, mas a resposta se perdeu; a segunda
 * diz "já utilizado" pelo mesmo portão, segundos depois. É a mesma pessoa: a
 * entrada foi liberada na primeira tentativa.
 */
export function acceptedOnRetry(response: CheckinResponse): ScanView {
  return {
    tone: 'ok',
    icon: 'check_circle',
    title: 'Entrada liberada',
    detail: 'A entrada foi registrada na tentativa anterior, que ficou sem resposta.',
    place: placeOf(response.ticket),
  };
}

/** Uma frase para leitores de tela e para o histórico. */
export function scanSentence(view: ScanView): string {
  return [view.title, view.place, view.detail].filter(Boolean).join('. ').replace(/\.\./g, '.');
}
