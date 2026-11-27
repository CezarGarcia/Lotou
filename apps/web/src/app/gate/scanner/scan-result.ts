import {
  lucideBan,
  lucideCalendarX,
  lucideCircleAlert,
  lucideCircleCheck,
  lucideCircleQuestionMark,
  lucideDoorClosed,
  lucideHistory,
  lucideLock,
  lucideScanQrCode,
  lucideWifiOff,
} from '@ng-icons/lucide';
import { formatInTimezone } from '../../core/format/show-date.pipe';
import { CheckinResponse, CheckinTicket } from '../data/checkin.api';

/** A cor da tela: verde libera, amarelo já entrou, vermelho barra. */
export type ScanTone = 'ok' | 'warn' | 'error';

/** Os ícones dos resultados, para o leitor registrar com `provideIcons`. */
export const SCAN_ICONS = {
  lucideBan,
  lucideCalendarX,
  lucideCircleAlert,
  lucideCircleCheck,
  lucideCircleQuestionMark,
  lucideDoorClosed,
  lucideHistory,
  lucideLock,
  lucideScanQrCode,
  lucideWifiOff,
};

/** O que a tela cheia mostra depois de uma leitura. */
export interface ScanView {
  tone: ScanTone;
  /** Nome do ícone Lucide (registrado em `SCAN_ICONS`). */
  icon: string;
  title: string;
  detail: string;
  /** Setor e lugar, quando o ingresso é conhecido. */
  place: string;
  /** Final do ingresso ("…ab81914b"), para conferir com o celular da pessoa. */
  ticket?: string;
  /** O que a portaria faz agora, quando não é óbvio. */
  advice?: string;
}

/** Final do ingresso: os últimos 8 caracteres do id, que o comprador vê no pedido. */
export function ticketEnd(ticket: CheckinTicket | null | undefined): string {
  const id = ticket?.ticketId ?? '';
  return id ? `…${id.slice(-8)}` : '';
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
  const ticket = ticketEnd(response.ticket);
  switch (response.result) {
    case 'ACCEPTED':
      return {
        tone: 'ok',
        icon: 'lucideCircleCheck',
        title: 'Entrada liberada',
        detail: '',
        place,
        ticket,
      };
    case 'ALREADY_USED': {
      const first = response.firstEntry;
      return {
        tone: 'warn',
        icon: 'lucideHistory',
        title: 'Ingresso já utilizado',
        detail: first
          ? `Entrou ${when(first.at, timezone, now)} pelo ${first.gate}.`
          : 'Este ingresso já entrou no show.',
        place,
        ticket,
        advice:
          'Se a pessoa diz que não entrou, chame a supervisão: a primeira leitura fica registrada com o portão e o horário.',
      };
    }
    case 'INVALID_CODE':
      return {
        tone: 'error',
        icon: 'lucideScanQrCode',
        title: 'QR code inválido',
        detail: 'Este código não é um ingresso do Lotou, ou foi alterado.',
        place,
        ticket,
      };
    case 'UNKNOWN_TICKET':
      return {
        tone: 'error',
        icon: 'lucideCircleQuestionMark',
        title: 'Ingresso não encontrado',
        detail:
          'O código parece certo, mas o ingresso não está na lista. Encaminhe ao atendimento.',
        place,
        ticket,
      };
    case 'CANCELLED':
      return {
        tone: 'error',
        icon: 'lucideBan',
        title: 'Ingresso cancelado',
        detail: 'O pedido foi cancelado ou reembolsado. Este ingresso não vale para a entrada.',
        place,
        ticket,
      };
    case 'WRONG_SHOW':
      return {
        tone: 'error',
        icon: 'lucideCalendarX',
        title: 'Ingresso de outro show',
        detail: 'Confira o show e a data no ingresso.',
        place,
        ticket,
      };
    case 'NOT_OPEN':
      return {
        tone: 'error',
        icon: 'lucideDoorClosed',
        title: 'Portões ainda fechados',
        detail: doorsOpenAt
          ? `A entrada abre ${when(doorsOpenAt, timezone, now)}.`
          : 'A entrada ainda não foi aberta.',
        place,
        ticket,
      };
    default:
      return {
        tone: 'error',
        icon: 'lucideCircleAlert',
        title: 'Entrada não liberada',
        detail: 'O sistema não reconheceu o resultado. Encaminhe ao atendimento.',
        place,
        ticket,
      };
  }
}

/** A leitura não chegou ao servidor (rede, servidor fora do ar). */
export function connectionFailure(message: string): ScanView {
  return {
    tone: 'error',
    icon: 'lucideWifiOff',
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
    icon: 'lucideCircleCheck',
    title: 'Entrada liberada',
    detail: 'A entrada foi registrada na tentativa anterior, que ficou sem resposta.',
    place: placeOf(response.ticket),
    ticket: ticketEnd(response.ticket),
  };
}

/** Uma frase para leitores de tela e para o histórico. */
export function scanSentence(view: ScanView): string {
  return [view.title, view.place, view.detail].filter(Boolean).join('. ').replace(/\.\./g, '.');
}

/** "23:42:17" no fuso do show: a hora de cada leitura, com segundos. */
export function clockOf(instant: string, timezone: string | undefined): string {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: timezone,
  }).format(new Date(instant));
}
