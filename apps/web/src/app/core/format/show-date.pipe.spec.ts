import { ShowDatePipe, formatInTimezone } from './show-date.pipe';

describe('formatInTimezone', () => {
  // 22h de 31/12/2030 em São Paulo; 1h de 1º/01/2031 em UTC.
  const instant = '2031-01-01T01:00:00.000Z';

  it('exibe a data no fuso do show, não em UTC nem no fuso do navegador', () => {
    expect(formatInTimezone(instant, 'America/Sao_Paulo', 'date')).toBe('31/12/2030');
    expect(formatInTimezone(instant, 'America/Sao_Paulo', 'time')).toBe('22:00');
    expect(formatInTimezone(instant, 'UTC', 'date')).toBe('01/01/2031');
    expect(formatInTimezone(instant, 'America/Manaus', 'time')).toBe('21:00');
  });

  it('formata dia, mês e dia da semana para o card', () => {
    expect(formatInTimezone(instant, 'America/Sao_Paulo', 'day')).toBe('31');
    expect(formatInTimezone(instant, 'America/Sao_Paulo', 'month')).toBe('dez');
    expect(formatInTimezone(instant, 'America/Sao_Paulo', 'weekday')).toBe('ter');
    expect(formatInTimezone(instant, 'America/Sao_Paulo', 'full')).toBe(
      'terça-feira, 31 de dezembro de 2030',
    );
  });
});

describe('ShowDatePipe', () => {
  it('devolve vazio quando não há data', () => {
    const pipe = new ShowDatePipe();
    expect(pipe.transform(null, 'America/Sao_Paulo')).toBe('');
    expect(pipe.transform('2031-01-01T01:00:00.000Z', 'America/Sao_Paulo', 'date')).toBe(
      '31/12/2030',
    );
  });
});
