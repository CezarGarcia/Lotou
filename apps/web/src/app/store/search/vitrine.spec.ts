import { ShowSummary } from '../data/show.models';
import { dayIn, isToday, pickFeatured, quickPeriods, resultsSummary, showBadge } from './vitrine';

const show = (id: string, changes: Partial<ShowSummary> = {}): ShowSummary => ({
  id,
  title: `Show ${id}`,
  artist: `Artista ${id}`,
  status: 'ON_SALE',
  startsAt: '2026-12-17T23:30:00.000Z',
  salesStartAt: null,
  highDemand: false,
  venue: { id: 'v', name: 'Local', city: 'Belém', state: 'PA', timezone: 'America/Belem' },
  priceFromCents: 5_000,
  ...changes,
});

// Sexta, 27/11/2026, 9h no relógio de quem compra.
const FRIDAY = new Date(2026, 10, 27, 9, 0);

describe('vitrine', () => {
  it('dá o dia no fuso pedido', () => {
    // 23h de 27/11 em Belém já é 28/11 em UTC.
    expect(dayIn('2026-11-28T02:00:00.000Z', 'America/Belem')).toBe('2026-11-27');
    expect(dayIn('2026-11-28T02:00:00.000Z', 'UTC')).toBe('2026-11-28');
  });

  it('monta os períodos dos filtros rápidos a partir de hoje', () => {
    const [today, weekend, month] = quickPeriods(FRIDAY);
    expect(today).toMatchObject({ label: 'Hoje', from: '2026-11-27', to: '2026-11-27' });
    expect(weekend).toMatchObject({ from: '2026-11-27', to: '2026-11-29' });
    expect(month).toMatchObject({ from: '2026-11-27', to: '2026-11-30' });
  });

  it('no meio da semana, o fim de semana começa na sexta seguinte', () => {
    const tuesday = new Date(2026, 11, 1, 12, 0);
    expect(quickPeriods(tuesday)[1]).toMatchObject({ from: '2026-12-04', to: '2026-12-06' });
  });

  it('sabe se o show é hoje no fuso dele', () => {
    const tonight = show('a', { startsAt: '2026-11-28T02:00:00.000Z' });
    const now = new Date('2026-11-27T15:00:00.000Z');
    expect(isToday(tonight, now)).toBe(true);
    expect(isToday(show('b'), now)).toBe(false);
  });

  it('destaca o próximo show com vendas abertas, deixando os de hoje para a faixa deles', () => {
    const now = new Date('2026-11-27T15:00:00.000Z');
    const shows = [
      show('hoje', { startsAt: '2026-11-28T02:00:00.000Z' }),
      show('em-breve', { status: 'PUBLISHED', startsAt: '2026-12-01T23:00:00.000Z' }),
      show('a-venda'),
    ];
    expect(pickFeatured(shows, now)?.id).toBe('a-venda');
    expect(pickFeatured([shows[1]], now)?.id).toBe('em-breve');
    expect(pickFeatured([shows[0]], now)?.id).toBe('hoje');
    expect(pickFeatured([], now)).toBeNull();
  });

  it('escolhe a etiqueta do cartão pelo que importa mais', () => {
    const now = new Date('2026-11-27T15:00:00.000Z');
    expect(showBadge(show('a', { status: 'CANCELLED' }), now)).toEqual({
      label: 'Cancelado',
      tone: 'danger',
    });
    expect(
      showBadge(show('b', { salesStartAt: '2026-12-07T15:00:00.000Z', status: 'PUBLISHED' }), now),
    ).toEqual({ label: 'Vendas em 07 dez', tone: 'info' });
    expect(showBadge(show('c', { startsAt: '2026-11-28T02:00:00.000Z' }), now)?.label).toBe('Hoje');
    expect(showBadge(show('d', { highDemand: true }), now)?.label).toBe('Alta demanda');
    expect(showBadge(show('e'), now)).toBeNull();
  });

  it('resume a vitrine em shows e cidades', () => {
    expect(resultsSummary([show('a'), show('b')])).toBe('2 shows em 1 cidade');
    expect(resultsSummary([show('a', { venue: null })])).toBe('1 show');
  });
});
