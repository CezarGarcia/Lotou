import { Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { interval, map } from 'rxjs';

/** Quanto falta até um instante, quebrado em dias, horas, minutos e segundos. */
export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** Total de segundos que faltam. */
  totalSeconds: number;
  /** `true` quando o instante já passou. */
  done: boolean;
}

export function countdownParts(targetMs: number, nowMs: number): CountdownParts {
  const remaining = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  return {
    days: Math.floor(remaining / 86_400),
    hours: Math.floor((remaining % 86_400) / 3_600),
    minutes: Math.floor((remaining % 3_600) / 60),
    seconds: remaining % 60,
    totalSeconds: remaining,
    done: remaining === 0,
  };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Cronômetro curto: `09:41`, ou `1:02:05` acima de uma hora. */
export function formatClock(parts: CountdownParts): string {
  const hours = parts.days * 24 + parts.hours;
  return hours > 0
    ? `${hours}:${pad(parts.minutes)}:${pad(parts.seconds)}`
    : `${pad(parts.minutes)}:${pad(parts.seconds)}`;
}

/** Tempo de espera aproximado, em palavras: "menos de 1 minuto", "cerca de 4 minutos". */
export function formatWait(seconds: number): string {
  if (seconds < 60) {
    return 'menos de 1 minuto';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `cerca de ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `cerca de ${hours} h${rest > 0 ? ` ${pad(rest)} min` : ''}`;
}

/**
 * O relógio da tela, em ms, atualizado a cada `periodMs`. Precisa de contexto
 * de injeção: para quando o componente é destruído.
 */
export function injectNow(periodMs = 1000): Signal<number> {
  return toSignal(interval(periodMs).pipe(map(() => Date.now())), { initialValue: Date.now() });
}
