import { areDoorsOpen, doorsOpenAt, startOfLocalDay } from './doors.js';

const at = (iso: string) => new Date(iso);

describe('abertura dos portões', () => {
  describe('com doorsOpenAt', () => {
    const show = {
      startsAt: at('2026-12-16T23:30:00Z'),
      doorsOpenAt: at('2026-12-16T22:00:00Z'),
      timezone: 'America/Sao_Paulo',
    };

    it('abre exatamente no horário informado', () => {
      expect(areDoorsOpen(show, at('2026-12-16T21:59:59.999Z'))).toBe(false);
      expect(areDoorsOpen(show, at('2026-12-16T22:00:00Z'))).toBe(true);
    });

    it('continua aberta depois do início do show', () => {
      expect(areDoorsOpen(show, at('2026-12-17T01:00:00Z'))).toBe(true);
    });

    it('o fuso não muda um instante já em UTC', () => {
      expect(
        doorsOpenAt({ ...show, timezone: 'Asia/Tokyo' }).toISOString(),
      ).toBe('2026-12-16T22:00:00.000Z');
    });
  });

  describe('sem doorsOpenAt, abre no começo do dia do show no fuso do local', () => {
    it('show às 21h em São Paulo (UTC-3): abre à meia-noite local, 3h em UTC', () => {
      const show = {
        startsAt: at('2026-12-17T00:00:00Z'), // 16/12, 21h em São Paulo
        doorsOpenAt: null,
        timezone: 'America/Sao_Paulo',
      };
      expect(doorsOpenAt(show).toISOString()).toBe('2026-12-16T03:00:00.000Z');
      // Às 23h de 15/12 em São Paulo já é 16/12 em UTC, mas ainda é véspera.
      expect(areDoorsOpen(show, at('2026-12-16T02:00:00Z'))).toBe(false);
      expect(areDoorsOpen(show, at('2026-12-16T03:00:00Z'))).toBe(true);
    });

    it('o mesmo instante em Manaus (UTC-4) é outro dia de portaria', () => {
      const show = {
        startsAt: at('2026-12-17T03:30:00Z'), // 16/12, 23h30 em Manaus
        doorsOpenAt: null,
        timezone: 'America/Manaus',
      };
      expect(doorsOpenAt(show).toISOString()).toBe('2026-12-16T04:00:00.000Z');
    });

    it('em Fernando de Noronha (UTC-2)', () => {
      const show = {
        startsAt: at('2026-07-10T22:00:00Z'),
        doorsOpenAt: null,
        timezone: 'America/Noronha',
      };
      expect(doorsOpenAt(show).toISOString()).toBe('2026-07-10T02:00:00.000Z');
    });

    it('em Lisboa, no verão (UTC+1) e no inverno (UTC+0)', () => {
      expect(
        startOfLocalDay(
          at('2026-07-10T20:00:00Z'),
          'Europe/Lisbon',
        ).toISOString(),
      ).toBe('2026-07-09T23:00:00.000Z');
      expect(
        startOfLocalDay(
          at('2026-12-10T20:00:00Z'),
          'Europe/Lisbon',
        ).toISOString(),
      ).toBe('2026-12-10T00:00:00.000Z');
    });

    it('no dia em que o horário de verão começa à meia-noite, o dia começa à 1h', () => {
      // 4/11/2018 em São Paulo: o relógio pulou de 23:59:59 para 1h.
      expect(
        startOfLocalDay(
          at('2018-11-04T22:00:00Z'),
          'America/Sao_Paulo',
        ).toISOString(),
      ).toBe('2018-11-04T03:00:00.000Z');
    });

    it('no dia em que o horário de verão acaba, a meia-noite acontece uma vez só', () => {
      // 17/2/2018 em São Paulo: à meia-noite de 18/2 o relógio voltou para 23h.
      expect(
        startOfLocalDay(
          at('2018-02-17T15:00:00Z'),
          'America/Sao_Paulo',
        ).toISOString(),
      ).toBe('2018-02-17T02:00:00.000Z');
    });
  });
});
