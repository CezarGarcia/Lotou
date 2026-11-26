import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ShowSummary } from '../data/show.models';
import { ShowCard } from './show-card';

const base: ShowSummary = {
  id: '01a218fd-18f6-7295-95c9-6cf50fae0ddb',
  title: 'Maracatu Elétrico ao Vivo',
  artist: 'Nação Coral',
  status: 'PUBLISHED',
  // 22h de 31/12/2030 em Recife; 1h de 1º/01/2031 em UTC.
  startsAt: '2031-01-01T01:00:00.000Z',
  salesStartAt: null,
  highDemand: false,
  venue: {
    id: 'v1',
    name: 'Estádio do Capibaribe',
    city: 'Recife',
    state: 'PE',
    timezone: 'America/Recife',
  },
  priceFromCents: 6_000,
};

async function render(show: ShowSummary): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(ShowCard);
  fixture.componentRef.setInput('show', show);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('ShowCard', () => {
  it('mostra artista, local, menor preço e a data no fuso do show', async () => {
    const card = await render(base);
    const text = card.textContent!.replace(/\s+/g, ' ');

    expect(card.querySelector('.artist')!.textContent).toBe('Nação Coral');
    expect(text).toContain('Estádio do Capibaribe · Recife/PE');
    expect(text).toContain('R$ 60,00');
    expect(card.querySelector('.day')!.textContent).toBe('31');
    expect(card.querySelector('.month')!.textContent).toBe('dez');
    expect(text).toContain('31/12/2030 às 22:00');
  });

  it('leva à página do show', async () => {
    const card = await render(base);
    expect(card.querySelector('a')!.getAttribute('href')).toBe(`/shows/${base.id}`);
  });

  it('destaca alta demanda e a abertura futura das vendas', async () => {
    const card = await render({
      ...base,
      highDemand: true,
      salesStartAt: '2999-01-01T13:00:00.000Z',
    });
    expect(card.querySelector('.badge')!.textContent).toBe('Alta demanda');
    expect(card.querySelector('.sales')!.textContent).toContain('Vendas em');
  });

  it('não anuncia abertura quando as vendas já começaram', async () => {
    const card = await render({ ...base, salesStartAt: '2020-01-01T13:00:00.000Z' });
    expect(card.querySelector('.sales')).toBeNull();
    expect(card.querySelector('.badge')).toBeNull();
  });
});
