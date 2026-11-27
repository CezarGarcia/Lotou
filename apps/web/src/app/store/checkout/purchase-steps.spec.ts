import { TestBed } from '@angular/core/testing';
import { PurchaseSteps } from './purchase-steps';

describe('PurchaseSteps', () => {
  async function render(current: number, seated: boolean) {
    const fixture = TestBed.createComponent(PurchaseSteps);
    fixture.componentRef.setInput('current', current);
    fixture.componentRef.setInput('seated', seated);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('marca a etapa atual e dá à primeira o nome do tipo de setor', async () => {
    const element = await render(1, true);
    const steps = [...element.querySelectorAll('li')];
    expect(steps.map((step) => step.querySelector('.label')!.textContent)).toEqual([
      'Cadeiras',
      'Pagamento',
      'Ingresso',
    ]);
    expect(steps[1].getAttribute('aria-current')).toBe('step');
    expect(steps[0].classList).toContain('done');
    expect(steps[2].hasAttribute('aria-current')).toBe(false);
  });

  it('na pista, a primeira etapa é escolher os ingressos', async () => {
    const element = await render(0, false);
    expect(element.querySelector('li .label')!.textContent).toBe('Ingressos');
  });
});
