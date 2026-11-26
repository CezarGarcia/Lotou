/** Quanto falta até um instante, quebrado em dias, horas, minutos e segundos. */
export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
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
    done: remaining === 0,
  };
}
