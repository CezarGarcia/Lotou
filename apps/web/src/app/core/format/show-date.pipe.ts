import { Pipe, PipeTransform } from '@angular/core';

export type ShowDateFormat = 'full' | 'date' | 'time' | 'day' | 'month' | 'weekday' | 'short';

const OPTIONS: Record<ShowDateFormat, Intl.DateTimeFormatOptions> = {
  full: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  date: { day: '2-digit', month: '2-digit', year: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit' },
  day: { day: '2-digit' },
  month: { month: 'short' },
  weekday: { weekday: 'short' },
  short: { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' },
};

/**
 * Formata um instante no fuso informado. As datas chegam em UTC e são
 * exibidas no fuso do show: um show às 21h em Recife aparece como 21h para
 * quem está em qualquer lugar.
 */
export function formatInTimezone(
  instant: string | Date,
  timezone: string | undefined,
  format: ShowDateFormat,
): string {
  const text = new Intl.DateTimeFormat('pt-BR', { ...OPTIONS[format], timeZone: timezone }).format(
    new Date(instant),
  );
  // "dez." e "sáb." viram "dez" e "sáb".
  return format === 'month' || format === 'weekday' ? text.replace('.', '') : text;
}

@Pipe({ name: 'showDate' })
export class ShowDatePipe implements PipeTransform {
  transform(
    instant: string | null | undefined,
    timezone: string | undefined,
    format: ShowDateFormat = 'full',
  ): string {
    return instant ? formatInTimezone(instant, timezone, format) : '';
  }
}
