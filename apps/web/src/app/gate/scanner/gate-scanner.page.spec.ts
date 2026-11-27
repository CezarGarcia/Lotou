import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { GateSettings } from '../gate-settings';
import { GateFeedback } from './gate-feedback';
import { GateScannerPage } from './gate-scanner.page';
import { GET_USER_MEDIA, QR_DETECTOR_FACTORY } from './qr-detector';

const SHOWS = [
  {
    showId: 's1',
    title: 'Turnê',
    artist: 'Banda do Mar',
    startsAt: '2026-12-17T00:00:00Z',
    timezone: 'America/Recife',
    doorsOpenAt: '2026-12-16T21:00:00Z',
    venueName: 'Arena',
  },
];

const plain = (text: string) => text.replace(/ /g, ' ').replace(/\s+/g, ' ');

describe('GateScannerPage', () => {
  let fixture: ComponentFixture<GateScannerPage>;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.spyOn>;

  const element = () => fixture.nativeElement as HTMLElement;

  async function settle() {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  }

  async function render(portao?: string, storedGate = '') {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: { login: vi.fn() } },
        { provide: GateFeedback, useValue: { signal: vi.fn(), unlock: vi.fn() } },
        // Sem câmera: o leitor usa o código digitado.
        { provide: GET_USER_MEDIA, useValue: undefined },
        { provide: QR_DETECTOR_FACTORY, useValue: () => Promise.reject(new Error('sem leitor')) },
      ],
    });
    TestBed.inject(GateSettings).gate.set(storedGate);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GateScannerPage);
    fixture.componentRef.setInput('showId', 's1');
    if (portao !== undefined) {
      fixture.componentRef.setInput('portao', portao);
    }
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/v1/checkins/shows').flush(SHOWS);
    await settle();
  }

  function type(code: string) {
    const input = element().querySelector<HTMLInputElement>('.manual input')!;
    input.value = code;
    input.dispatchEvent(new Event('input'));
    element().querySelector<HTMLFormElement>('.manual')!.dispatchEvent(new Event('submit'));
  }

  it('mostra o show, o portão e o contador', async () => {
    await render('Portão B');
    await new Promise((resolve) => setTimeout(resolve, 0));
    http
      .expectOne('/api/v1/checkins/shows/s1/summary')
      .flush({ checkedIn: 1240, byGate: [{ gate: 'Portão B', count: 310 }], rejected: 3 });
    await settle();
    const text = plain(element().textContent!);
    expect(text).toContain('Banda do Mar');
    expect(text).toContain('Portão B');
    expect(text).toContain('No show1.240');
    expect(text).toContain('Neste portão310');
    expect(text).toContain('Recusadas3');
    // Sem câmera, a tela diz para digitar.
    expect(text).toMatch(/Nenhuma câmera disponível|conexão segura/);
  });

  it('lê o código digitado e mostra o resultado em tela cheia, anunciado', async () => {
    await render('Portão B');
    type('LOTOU1.t9.sig');
    const request = http.expectOne('/api/v1/checkins');
    expect(request.request.body).toEqual({ showId: 's1', gate: 'Portão B', code: 'LOTOU1.t9.sig' });
    // O campo fica limpo para o próximo código.
    expect(element().querySelector<HTMLInputElement>('.manual input')!.value).toBe('');
    request.flush({
      result: 'ALREADY_USED',
      ticket: { ticketId: 't9', sectorName: 'Plateia', seat: 'A-5' },
      firstEntry: { at: '2026-12-16T23:31:00Z', gate: 'Portão A' },
    });
    await settle();

    const result = element().querySelector('.result')!;
    expect(result.getAttribute('data-tone')).toBe('warn');
    expect(plain(result.textContent!)).toContain('Ingresso já utilizado');
    expect(plain(result.textContent!)).toContain('Plateia · Cadeira A-5');
    expect(plain(result.textContent!)).toMatch(/Entrou (em 16\/12 )?às 20:31 pelo Portão A/);
    // O final do ingresso, para conferir com o celular da pessoa, e o que fazer.
    expect(plain(result.textContent!)).toContain('…t9');
    expect(plain(result.textContent!)).toContain('chame a supervisão');
    // A barra de tempo dura o mesmo que o resultado na tela.
    expect(result.getAttribute('style')).toContain('--tempo: 5000ms');
    const live = element().querySelector('[aria-live="assertive"]')!;
    expect(live.textContent).toContain('Ingresso já utilizado');

    // Esc tira o resultado: pronto para a próxima leitura.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await settle();
    expect(element().querySelector('.result')).toBeNull();
  });

  it.each([
    ['ACCEPTED', 'ok', 'Entrada liberada'],
    ['CANCELLED', 'error', 'Ingresso cancelado'],
    ['WRONG_SHOW', 'error', 'Ingresso de outro show'],
  ])('%s fica %s', async (resultCode, tone, title) => {
    await render('Portão B');
    type('X');
    http
      .expectOne('/api/v1/checkins')
      .flush({ result: resultCode, ticket: null, firstEntry: null });
    await settle();
    const result = element().querySelector('.result')!;
    expect(result.getAttribute('data-tone')).toBe(tone);
    expect(result.textContent).toContain(title);
  });

  it('o botão "Próxima leitura" tem alvo grande e libera o leitor', async () => {
    await render('Portão B');
    type('X');
    http
      .expectOne('/api/v1/checkins')
      .flush({ result: 'ACCEPTED', ticket: null, firstEntry: null });
    await settle();
    const next = element().querySelector<HTMLButtonElement>('.result .next')!;
    expect(next.textContent).toContain('Próxima leitura');
    next.click();
    await settle();
    expect(element().querySelector('.result')).toBeNull();
  });

  it('o histórico guarda as leituras com a cor e a hora, a mais recente primeiro', async () => {
    await render('Portão B');
    for (const result of ['ACCEPTED', 'INVALID_CODE']) {
      type('X');
      http.expectOne('/api/v1/checkins').flush({ result, ticket: null, firstEntry: null });
      await settle();
    }
    const items = [...element().querySelectorAll('.history li')];
    expect(items.map((item) => item.getAttribute('data-tone'))).toEqual(['error', 'ok']);
    expect(items[0].querySelector('time')!.textContent).toMatch(/^\s*\d{2}:\d{2}:\d{2}\s*$/);
  });

  it('o topo volta à escolha do show e do portão, com o show já escolhido', async () => {
    await render('Portão B');
    const back = element().querySelector<HTMLAnchorElement>(
      'a[aria-label="Trocar show ou portão"]',
    )!;
    expect(back.getAttribute('href')).toBe('/portaria?show=s1');
    expect(element().querySelector('h1')!.textContent).toContain('Banda do Mar');
    expect(element().querySelector('.gate')!.textContent).toContain('Portão B');
  });

  it('usa o portão guardado no aparelho quando a URL não traz', async () => {
    await render(undefined, 'Portão C');
    expect(plain(element().textContent!)).toContain('Portão C');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sem portão nenhum, volta à escolha do show e do portão', async () => {
    await render(undefined, '');
    expect(navigate).toHaveBeenCalledWith(['/portaria'], {
      queryParams: { show: 's1' },
      replaceUrl: true,
    });
  });
});
