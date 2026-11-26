import { countdownParts, formatClock, formatWait } from './countdown';

describe('countdownParts', () => {
  const now = Date.UTC(2027, 0, 1, 12, 0, 0);
  const seconds = (value: number) => now + value * 1000;

  it('quebra o tempo restante em dias, horas, minutos e segundos', () => {
    const target = seconds(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5);
    expect(countdownParts(target, now)).toEqual({
      days: 2,
      hours: 3,
      minutes: 4,
      seconds: 5,
      totalSeconds: 2 * 86_400 + 3 * 3_600 + 4 * 60 + 5,
      done: false,
    });
  });

  it('termina em zero quando o instante chega ou já passou', () => {
    const zero = { days: 0, hours: 0, minutes: 0, seconds: 0, totalSeconds: 0, done: true };
    expect(countdownParts(now, now)).toEqual(zero);
    expect(countdownParts(seconds(-30), now)).toEqual(zero);
  });

  it('não marca como encerrado enquanto falta um segundo', () => {
    expect(countdownParts(seconds(1), now)).toMatchObject({ seconds: 1, done: false });
  });
});

describe('formatClock', () => {
  const now = 0;
  const clock = (secondsLeft: number) => formatClock(countdownParts(secondsLeft * 1000, now));

  it('mostra minutos e segundos no cronômetro da reserva', () => {
    expect(clock(600)).toBe('10:00');
    expect(clock(581)).toBe('09:41');
    expect(clock(5)).toBe('00:05');
    expect(clock(0)).toBe('00:00');
  });

  it('inclui as horas quando passa de uma hora', () => {
    expect(clock(3_725)).toBe('1:02:05');
    expect(clock(86_400 + 60)).toBe('24:01:00');
  });
});

describe('formatWait', () => {
  it('arredonda a espera da fila para algo que se lê de relance', () => {
    expect(formatWait(20)).toBe('menos de 1 minuto');
    expect(formatWait(80)).toBe('cerca de 1 minuto');
    expect(formatWait(250)).toBe('cerca de 4 minutos');
    expect(formatWait(3_600)).toBe('cerca de 1 h');
    expect(formatWait(5_400)).toBe('cerca de 1 h 30 min');
  });
});
