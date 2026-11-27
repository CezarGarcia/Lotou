/**
 * Conversão entre um horário de parede num fuso IANA (o do show) e o
 * instante em UTC que a API grava. O produtor digita "31/12 às 23:59" pensando
 * no fuso do local, não no do navegador dele.
 *
 * Só usa `Intl`: nenhuma biblioteca de datas entra no pacote.
 */

/** Diferença, em ms, entre o horário de parede no fuso e o UTC, num instante. */
function offsetMs(instant: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * `"2026-12-31T23:59"` no fuso `America/Recife` vira `"2027-01-01T02:59:00.000Z"`.
 * `null` para texto fora do formato do `<input type="datetime-local">`.
 *
 * Num horário de verão, a hora que não existe (o relógio pula) cai depois do
 * pulo, e a que se repete fica com a primeira ocorrência.
 */
export function zonedLocalToUtc(local: string, timezone: string): string | null {
  const match = LOCAL.exec(local);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (Number.isNaN(wall)) {
    return null;
  }
  // Primeiro palpite com o deslocamento daquele momento; o segundo corrige
  // quando o palpite cai do outro lado de uma mudança de horário.
  const first = wall - offsetMs(wall, timezone);
  const second = wall - offsetMs(first, timezone);
  const valid = [first, second].filter((instant) => instant + offsetMs(instant, timezone) === wall);
  return new Date(valid.length > 0 ? Math.min(...valid) : Math.max(first, second)).toISOString();
}

/** O contrário: o instante em UTC como `"AAAA-MM-DDTHH:mm"` no fuso, para o campo. */
export function utcToZonedLocal(instant: string | number | Date, timezone: string): string {
  const time = new Date(instant).getTime();
  const wall = new Date(time + offsetMs(time, timezone));
  return wall.toISOString().slice(0, 16);
}
