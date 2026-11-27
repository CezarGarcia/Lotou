import { formatInTimezone } from '../../core/format/show-date.pipe';
import { ShowSummary } from '../data/show.models';

/** Um filtro rápido de período: preenche `from` e `to` da busca. */
export interface QuickPeriod {
  id: 'hoje' | 'fim-de-semana' | 'mes';
  label: string;
  /** Dias no formato AAAA-MM-DD, como a busca espera. */
  from: string;
  to: string;
}

/** O dia de um instante no fuso informado (ou no do navegador), em AAAA-MM-DD. */
export function dayIn(instant: string | Date, timezone?: string): string {
  // O formato canadense já sai como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(new Date(instant));
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/**
 * Os períodos dos filtros rápidos, a partir de hoje (no relógio de quem
 * compra). O fim de semana vai de sexta a domingo: show de sexta à noite já é
 * programa de fim de semana. Se hoje já é sexta, sábado ou domingo, começa hoje.
 */
export function quickPeriods(now: Date): QuickPeriod[] {
  const today = dayIn(now);
  const weekday = now.getDay();
  const toFriday = weekday === 0 || weekday >= 5 ? 0 : 5 - weekday;
  const toSunday = weekday === 0 ? 0 : 7 - weekday;
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return [
    { id: 'hoje', label: 'Hoje', from: today, to: today },
    {
      id: 'fim-de-semana',
      label: 'Este fim de semana',
      from: dayIn(addDays(now, toFriday)),
      to: dayIn(addDays(now, toSunday)),
    },
    { id: 'mes', label: 'Este mês', from: today, to: dayIn(lastOfMonth) },
  ];
}

/** O show acontece hoje, no fuso do local dele. */
export function isToday(show: ShowSummary, now: Date): boolean {
  const timezone = show.venue?.timezone;
  return dayIn(show.startsAt, timezone) === dayIn(now, timezone);
}

/**
 * O destaque da página inicial: o próximo show com vendas abertas; sem
 * nenhum, o mais próximo. Os shows de hoje já têm a faixa deles, então só
 * entram se não houver outro.
 */
export function pickFeatured(shows: ShowSummary[], now: Date): ShowSummary | null {
  const upcoming = shows.filter((show) => show.status !== 'CANCELLED');
  const later = upcoming.filter((show) => !isToday(show, now));
  const pool = later.length > 0 ? later : upcoming;
  return pool.find((show) => show.status === 'ON_SALE') ?? pool[0] ?? null;
}

export type BadgeTone = 'ok' | 'info' | 'warn' | 'danger';

/** A etiqueta de estado do cartão: o que o comprador precisa saber antes de clicar. */
export interface ShowBadge {
  label: string;
  tone: BadgeTone;
}

export function showBadge(show: ShowSummary, now: Date): ShowBadge | null {
  const timezone = show.venue?.timezone;
  if (show.status === 'CANCELLED') {
    return { label: 'Cancelado', tone: 'danger' };
  }
  if (show.status === 'SALES_CLOSED') {
    return { label: 'Vendas encerradas', tone: 'danger' };
  }
  const opensLater =
    show.salesStartAt !== null && new Date(show.salesStartAt).getTime() > now.getTime();
  if (opensLater) {
    const day = `${formatInTimezone(show.salesStartAt!, timezone, 'day')} ${formatInTimezone(show.salesStartAt!, timezone, 'month')}`;
    return show.highDemand
      ? { label: `Fila virtual · vendas em ${day}`, tone: 'info' }
      : { label: `Vendas em ${day}`, tone: 'info' };
  }
  if (isToday(show, now)) {
    return { label: 'Hoje', tone: 'ok' };
  }
  return show.highDemand ? { label: 'Alta demanda', tone: 'warn' } : null;
}

/** "6 shows em 4 cidades". */
export function resultsSummary(shows: ShowSummary[]): string {
  const cities = new Set(shows.map((show) => show.venue?.city).filter(Boolean)).size;
  const showsText = shows.length === 1 ? '1 show' : `${shows.length} shows`;
  if (cities === 0) {
    return showsText;
  }
  return `${showsText} em ${cities === 1 ? '1 cidade' : `${cities} cidades`}`;
}
