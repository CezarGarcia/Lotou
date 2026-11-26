import { TestBed } from '@angular/core/testing';
import { SeatMap } from './seat-map';
import { SeatMapState } from './seat-map.state';

async function render() {
  const state = new SeatMapState([
    { label: 'A', seatCount: 3 },
    { label: 'B', seatCount: 3 },
  ]);
  const fixture = TestBed.createComponent(SeatMap);
  fixture.componentRef.setInput('state', state);
  fixture.componentRef.setInput('sectorName', 'Plateia');
  const toggled: string[] = [];
  fixture.componentInstance.toggled.subscribe((label) => toggled.push(label));
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;
  const seat = (label: string) => element.querySelector<SVGGElement>(`[data-seat="${label}"]`)!;
  return { fixture, state, element, seat, toggled };
}

describe('SeatMap', () => {
  it('desenha uma fileira por linha, com o nome da fileira e as cadeiras numeradas', async () => {
    const { element } = await render();
    const rows = element.querySelectorAll('[role="row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('[role="rowheader"]')!.textContent!.trim()).toBe('A');
    expect(rows[0].querySelectorAll('[role="gridcell"]').length).toBe(3);
    expect(element.querySelector('svg[role="grid"]')!.getAttribute('aria-label')).toBe(
      'Cadeiras do setor Plateia',
    );
  });

  it('pinta as cadeiras pela situação e atualiza só a que mudou', async () => {
    const { fixture, state, seat } = await render();
    state.applySnapshot([
      { label: 'A-1', available: true },
      { label: 'A-2', available: false },
    ]);
    await fixture.whenStable();
    const before = seat('A-1');
    expect(before.classList).toContain('free');
    expect(seat('A-2').classList).toContain('taken');
    expect(seat('A-2').getAttribute('aria-label')).toBe('Fileira A, cadeira 2, ocupada');

    state.applyChange({ sectorId: 's', seats: ['A-1'], available: false });
    await fixture.whenStable();
    // O mesmo elemento, só com outra classe: o mapa não é redesenhado.
    expect(seat('A-1')).toBe(before);
    expect(before.classList).toContain('taken');
  });

  it('marca a cadeira escolhida com aria-selected', async () => {
    const { fixture, state, seat } = await render();
    state.applySnapshot([{ label: 'B-2', available: true }]);
    state.toggle('B-2');
    await fixture.whenStable();
    expect(seat('B-2').getAttribute('aria-selected')).toBe('true');
    expect(seat('B-2').classList).toContain('selected');
  });

  it('anda pelas cadeiras com as setas e escolhe com Enter', async () => {
    const { fixture, element, seat, toggled } = await render();
    const svg = element.querySelector('svg[role="grid"]')!;
    // Só uma cadeira entra no Tab: a primeira.
    expect(element.querySelectorAll('[tabindex="0"]').length).toBe(1);
    expect(seat('A-1').getAttribute('tabindex')).toBe('0');

    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await fixture.whenStable();
    expect(seat('B-2').getAttribute('tabindex')).toBe('0');

    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    seat('A-3').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggled).toEqual(['B-2', 'A-3']);
  });
});
