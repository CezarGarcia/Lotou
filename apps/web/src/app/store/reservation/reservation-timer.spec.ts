import { TestBed } from '@angular/core/testing';
import { ReservationTimer } from './reservation-timer';

describe('ReservationTimer', () => {
  async function render(warning: boolean) {
    const fixture = TestBed.createComponent(ReservationTimer);
    fixture.componentRef.setInput('clock', warning ? '01:30' : '09:41');
    fixture.componentRef.setInput('percent', warning ? 15 : 97);
    fixture.componentRef.setInput('warning', warning);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('mostra o tempo e a barra do prazo que resta', async () => {
    const element = await render(false);
    expect(element.querySelector('[role="timer"]')!.textContent).toBe('09:41');
    expect(element.querySelector<HTMLElement>('.bar span')!.style.width).toBe('97%');
    expect(element.classList).not.toContain('warning');
  });

  it('fica em alerta perto do fim e pede para pagar logo', async () => {
    const element = await render(true);
    expect(element.classList).toContain('warning');
    expect(element.textContent).toContain('pague agora');
  });
});
