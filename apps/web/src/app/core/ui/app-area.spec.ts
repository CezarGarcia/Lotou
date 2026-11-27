import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AppArea } from './app-area';

@Component({ template: '' })
class Blank {}

describe('AppArea', () => {
  let router: Router;
  let area: AppArea;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '**', component: Blank }])],
    });
    router = TestBed.inject(Router);
    area = TestBed.inject(AppArea);
  });

  async function open(url: string): Promise<void> {
    await router.navigateByUrl(url);
    TestBed.tick();
  }

  it('a loja usa o tema noite e mostra as abas na vitrine', async () => {
    await open('/?city=Recife');
    expect(area.area()).toBe('loja');
    expect(area.tabs()).toBe(true);
    expect(document.documentElement.classList).toContain('tema-noite');
  });

  it('as telas de compra não têm a barra de abas', async () => {
    await open('/shows/123/comprar/456');
    expect(area.tabs()).toBe(false);
  });

  it('o painel usa o tema dia', async () => {
    await open('/painel/shows/123');
    expect(area.area()).toBe('painel');
    expect(document.documentElement.classList).toContain('tema-dia');
    expect(document.documentElement.classList).not.toContain('tema-noite');
  });

  it('o leitor da portaria fica em modo foco, e a escolha do show não', async () => {
    await open('/portaria');
    expect(area.area()).toBe('portaria');
    expect(area.focus()).toBe(false);
    await open('/portaria/shows/123?portao=A');
    expect(area.focus()).toBe(true);
    expect(area.theme()).toBe('noite');
  });
});
