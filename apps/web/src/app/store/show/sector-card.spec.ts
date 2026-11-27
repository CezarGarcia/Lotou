import { TestBed } from '@angular/core/testing';
import { SectorAvailability } from '../data/sale.models';
import { Sector } from '../data/show.models';
import { SectorCard } from './sector-card';

const SECTOR: Sector = {
  id: 'plateia',
  name: 'Plateia',
  kind: 'RESERVED_SEATING',
  capacity: 820,
  rows: [],
  lots: [
    { id: 'l1', name: '1º lote', priceCents: 16_000, quantity: 400, opensAt: null },
    { id: 'l2', name: '2º lote', priceCents: 19_000, quantity: 420, opensAt: null },
  ],
};

const live = (changes: Partial<SectorAvailability> = {}): SectorAvailability => ({
  id: 'plateia',
  name: 'Plateia',
  kind: 'RESERVED_SEATING',
  capacity: 820,
  sale: 'ON_SALE',
  lot: { id: 'l1', name: '1º lote', priceCents: 16_000 },
  available: 128,
  ...changes,
});

async function render(availability?: SectorAvailability) {
  const fixture = TestBed.createComponent(SectorCard);
  fixture.componentRef.setInput('sector', SECTOR);
  fixture.componentRef.setInput('live', availability);
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;
  return { element, text: () => element.textContent!.replace(/\s+/g, ' ') };
}

describe('SectorCard', () => {
  it('mostra o lote em venda, quanto dele saiu e o lote seguinte', async () => {
    const { element, text } = await render(live());
    expect(text()).toContain('Lugar marcado · 820 lugares');
    expect(text()).toContain('1º lote · R$ 160,00');
    expect(text()).toContain('68% do lote vendido');
    expect(text()).toContain('Restam 128 ingressos neste lote.');
    expect(text()).toContain('Depois dele vem o 2º lote, a R$ 190,00.');
    expect(element.querySelector<HTMLElement>('.bar div')!.style.width).toBe('68%');
  });

  it('esconde a porcentagem quando sobra de lote anterior passou para este', async () => {
    const { element, text } = await render(live({ available: 450 }));
    expect(text()).not.toContain('vendido');
    expect(element.querySelector('.bar')).toBeNull();
  });

  it('sem lote em venda, lista os preços dos lotes', async () => {
    const { element, text } = await render(live({ sale: 'NOT_OPEN', lot: null, available: 0 }));
    expect(element.querySelectorAll('.lots li')).toHaveLength(2);
    expect(text()).toContain('Em breve');
    expect(text()).toContain('R$ 190,00');
  });
});
