import { utcToZonedLocal, zonedLocalToUtc } from './zoned-time';

describe('zonedLocalToUtc', () => {
  it('interpreta o horário no fuso do show, não no do navegador', () => {
    expect(zonedLocalToUtc('2026-12-31T23:59', 'America/Recife')).toBe('2027-01-01T02:59:00.000Z');
    expect(zonedLocalToUtc('2026-12-31T23:59', 'America/Manaus')).toBe('2027-01-01T03:59:00.000Z');
    expect(zonedLocalToUtc('2026-06-01T10:00', 'UTC')).toBe('2026-06-01T10:00:00.000Z');
  });

  it('respeita o horário de verão de outros fusos', () => {
    // Nova York: UTC-5 no inverno, UTC-4 no verão.
    expect(zonedLocalToUtc('2026-01-15T20:00', 'America/New_York')).toBe(
      '2026-01-16T01:00:00.000Z',
    );
    expect(zonedLocalToUtc('2026-07-15T20:00', 'America/New_York')).toBe(
      '2026-07-16T00:00:00.000Z',
    );
    // 02:30 não existe em 8/3/2026 (o relógio pula de 02:00 para 03:00): cai depois do pulo.
    expect(zonedLocalToUtc('2026-03-08T02:30', 'America/New_York')).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    // 01:30 acontece duas vezes em 1/11/2026: fica a primeira.
    expect(zonedLocalToUtc('2026-11-01T01:30', 'America/New_York')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('recusa texto fora do formato do campo', () => {
    expect(zonedLocalToUtc('', 'America/Recife')).toBeNull();
    expect(zonedLocalToUtc('31/12/2026 23:59', 'America/Recife')).toBeNull();
  });
});

describe('utcToZonedLocal', () => {
  it('mostra o instante como horário de parede do fuso', () => {
    expect(utcToZonedLocal('2027-01-01T02:59:00Z', 'America/Recife')).toBe('2026-12-31T23:59');
    expect(utcToZonedLocal('2026-07-16T00:00:00Z', 'America/New_York')).toBe('2026-07-15T20:00');
  });

  it('ida e volta dão o mesmo instante', () => {
    const instant = '2026-12-16T22:31:00.000Z';
    expect(
      zonedLocalToUtc(utcToZonedLocal(instant, 'America/Sao_Paulo'), 'America/Sao_Paulo'),
    ).toBe(instant);
  });
});
