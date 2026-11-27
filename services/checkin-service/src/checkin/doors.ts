/** O que a regra da abertura dos portões precisa saber do show. */
export interface ShowSchedule {
  startsAt: Date;
  /** Abertura dos portões informada pelo produtor; pode faltar. */
  doorsOpenAt: Date | null;
  /** Fuso do local (IANA), ex.: `America/Sao_Paulo`. */
  timezone: string;
}

/**
 * Quando a portaria passa a aceitar ingressos. É o `doorsOpenAt` do show; sem
 * ele, o começo do dia do show no fuso do local: a portaria abre no dia do
 * show, nunca na véspera, e o "dia" é o de quem está na porta, não o do
 * servidor em UTC (um show às 23h30 em São Paulo começa às 2h30 do dia
 * seguinte em UTC).
 */
export function doorsOpenAt(show: ShowSchedule): Date {
  return show.doorsOpenAt ?? startOfLocalDay(show.startsAt, show.timezone);
}

/** A portaria já aceita ingressos deste show? */
export function areDoorsOpen(show: ShowSchedule, now: Date): boolean {
  return now.getTime() >= doorsOpenAt(show).getTime();
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** Data e hora de parede do instante no fuso, como se fossem UTC (em ms). */
function wallClock(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function localDate(instant: number, timeZone: string): LocalDate {
  const wall = new Date(wallClock(instant, timeZone));
  return {
    year: wall.getUTCFullYear(),
    month: wall.getUTCMonth() + 1,
    day: wall.getUTCDate(),
  };
}

const sameDate = (a: LocalDate, b: LocalDate) =>
  a.year === b.year && a.month === b.month && a.day === b.day;

/**
 * O primeiro instante do dia local de `instant` no fuso. Em geral é a
 * meia-noite local; num dia em que o horário de verão começa à meia-noite (o
 * Brasil fazia assim até 2019), a meia-noite não existe e o dia começa à 1h.
 */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const target = localDate(instant.getTime(), timeZone);
  const midnightAsUtc = Date.UTC(target.year, target.month - 1, target.day);
  const offsetAt = (at: number) => wallClock(at, timeZone) - at;

  // O deslocamento do fuso pode mudar entre a meia-noite em UTC e a local:
  // calcula com os dois e fica com o primeiro que cai no dia certo.
  const first = midnightAsUtc - offsetAt(midnightAsUtc);
  const second = midnightAsUtc - offsetAt(first);
  const candidates = [first, second]
    .filter((at) => sameDate(localDate(at, timeZone), target))
    .sort((a, b) => a - b);
  return new Date(candidates[0] ?? Math.max(first, second));
}
