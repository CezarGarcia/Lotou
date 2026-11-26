import { countdownParts } from './countdown';

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
      done: false,
    });
  });

  it('termina em zero quando o instante chega ou já passou', () => {
    const zero = { days: 0, hours: 0, minutes: 0, seconds: 0, done: true };
    expect(countdownParts(now, now)).toEqual(zero);
    expect(countdownParts(seconds(-30), now)).toEqual(zero);
  });

  it('não marca como encerrado enquanto falta um segundo', () => {
    expect(countdownParts(seconds(1), now)).toMatchObject({ seconds: 1, done: false });
  });
});
