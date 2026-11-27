import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Cartaz } from './cartaz';
import { cartazPalette } from './cartaz-palette';

describe('Cartaz', () => {
  let fixture: ComponentFixture<Cartaz>;
  let host: HTMLElement;

  beforeEach(() => {
    fixture = TestBed.createComponent(Cartaz);
    fixture.componentRef.setInput('artist', 'Marina Céu');
    fixture.componentRef.setInput('eyebrow', 'São Paulo · SP');
    fixture.componentRef.setInput('date', '2027-01-11T23:00:00Z');
    fixture.componentRef.setInput('timezone', 'America/Sao_Paulo');
    fixture.detectChanges();
    host = fixture.nativeElement;
  });

  it('mostra o artista, o local e o carimbo da data no fuso do show', () => {
    expect(host.querySelector('.artist')?.textContent).toContain('Marina Céu');
    expect(host.querySelector('.where')?.textContent).toContain('São Paulo · SP');
    expect(host.querySelector('app-date-stamp')?.textContent).toContain('11');
    expect(host.querySelector('app-date-stamp')?.textContent?.toLowerCase()).toContain('jan');
  });

  it('pinta com a tinta do artista e fica fora da árvore de acessibilidade', () => {
    expect(host.getAttribute('data-tinta')).toBe(cartazPalette('Marina Céu').name);
    expect(host.getAttribute('aria-hidden')).toBe('true');
  });

  it('a miniatura não tem carimbo nem local', () => {
    fixture.componentRef.setInput('size', 'mini');
    fixture.detectChanges();
    expect(host.querySelector('app-date-stamp')).toBeNull();
    expect(host.querySelector('.where')).toBeNull();
  });
});
