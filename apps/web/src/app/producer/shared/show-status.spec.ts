import { TestBed } from '@angular/core/testing';
import { ShowStatus } from './show-status';

describe('ShowStatus', () => {
  function render(status: string) {
    const fixture = TestBed.createComponent(ShowStatus);
    fixture.componentRef.setInput('status', status);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('à venda: rótulo em português e o ponto aceso', () => {
    const element = render('ON_SALE');
    expect(element.textContent!.trim()).toBe('À venda');
    expect(element.getAttribute('data-status')).toBe('ON_SALE');
    expect(element.querySelector('.dot')).not.toBeNull();
  });

  it('nos outros estados, só o rótulo', () => {
    const element = render('CANCELLED');
    expect(element.textContent!.trim()).toBe('Cancelado');
    expect(element.querySelector('.dot')).toBeNull();
  });

  it('estado novo aparece como veio', () => {
    expect(render('ON_HOLD').textContent!.trim()).toBe('ON_HOLD');
  });
});
