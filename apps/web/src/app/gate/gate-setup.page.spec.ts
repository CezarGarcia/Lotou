import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { GateSetupPage } from './gate-setup.page';
import { GateSettings } from './gate-settings';
import { GATE_OFFLINE_DB, MemoryGateOfflineDb } from './offline/gate-offline-db';
import { CAMAROTE, PISTA, testPackage } from './offline/offline.testing';

const show = (showId: string, artist: string) => ({
  showId,
  title: 'Turnê',
  artist,
  startsAt: '2026-12-17T00:00:00Z',
  timezone: 'America/Recife',
  doorsOpenAt: '2026-12-16T21:00:00Z',
  venueName: 'Arena',
});

describe('GateSetupPage', () => {
  let fixture: ComponentFixture<GateSetupPage>;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.spyOn>;
  let settings: GateSettings;
  let db: MemoryGateOfflineDb;

  const element = () => fixture.nativeElement as HTMLElement;

  /** Espera as respostas e o armazenamento do aparelho (promessas) e desenha. */
  async function settle() {
    await fixture.whenStable();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  }

  beforeEach(() => {
    db = new MemoryGateOfflineDb();
  });

  async function render(shows: object, wanted?: string) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: GATE_OFFLINE_DB, useValue: db },
      ],
    });
    settings = TestBed.inject(GateSettings);
    settings.gate.set('');
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GateSetupPage);
    if (wanted) {
      fixture.componentRef.setInput('show', wanted);
    }
    fixture.detectChanges();
    http.expectOne('/api/v1/checkins/shows').flush(shows);
    await settle();
    fixture.detectChanges();
  }

  function setGate(value: string) {
    const input = element().querySelector<HTMLInputElement>('input[formControlName="gate"]')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  const submit = () => element().querySelector<HTMLButtonElement>('button[type="submit"]')!;

  it('lista os shows com a abertura dos portões no fuso do show', async () => {
    await render([show('s1', 'Banda A'), show('s2', 'Banda B')]);
    const text = element().textContent!.replace(/ /g, ' ');
    expect(element().querySelectorAll('input[type="radio"]').length).toBe(2);
    expect(text).toContain('Portões abrem às 18:00');
    expect(submit().disabled).toBe(true);
  });

  it('com um show só, já vem escolhido; guarda o portão e abre o leitor', async () => {
    await render({ items: [show('s1', 'Banda A')] });
    setGate('  Portão   B ');
    expect(submit().disabled).toBe(false);
    submit().click();
    expect(settings.gate()).toBe('Portão B');
    expect(navigate).toHaveBeenCalledWith(['/portaria/shows', 's1'], {
      queryParams: { portao: 'Portão B' },
    });
  });

  it('volta do leitor com o show escolhido', async () => {
    await render([show('s1', 'Banda A'), show('s2', 'Banda B')], 's2');
    const radios = [...element().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((radio) => radio.checked)).toEqual([false, true]);
  });

  it('as sugestões preenchem o portão com um toque', async () => {
    await render([show('s1', 'Banda A')]);
    const chip = [...element().querySelectorAll<HTMLButtonElement>('.suggestions button')].find(
      (button) => button.textContent!.trim() === 'Acesso PCD',
    )!;
    chip.click();
    fixture.detectChanges();
    expect(element().querySelector<HTMLInputElement>('input[formControlName="gate"]')!.value).toBe(
      'Acesso PCD',
    );
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(submit().disabled).toBe(false);
  });

  it('marca os shows de hoje', async () => {
    const tonight = { ...show('s1', 'Banda A'), startsAt: new Date().toISOString() };
    await render([tonight, show('s2', 'Banda B')]);
    const cards = element().querySelectorAll('.show');
    expect(cards[0].querySelector('.today')?.textContent).toContain('Hoje');
    expect(cards[1].querySelector('.today')).toBeNull();
  });

  it('não começa sem portão', async () => {
    await render([show('s1', 'Banda A')]);
    setGate('   ');
    expect(submit().disabled).toBe(true);
  });

  it('mostra o erro e tenta de novo', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: GATE_OFFLINE_DB, useValue: db },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GateSetupPage);
    fixture.detectChanges();
    http
      .expectOne('/api/v1/checkins/shows')
      .flush({ title: 'Fora do ar', status: 503 }, { status: 503, statusText: 'Unavailable' });
    await settle();
    fixture.detectChanges();
    expect(element().querySelector('[role="alert"]')!.textContent).toContain('Fora do ar');
    element().querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    fixture.detectChanges();
    http.expectOne('/api/v1/checkins/shows').flush([]);
    fixture.detectChanges();
    expect(element().textContent).toContain('Nenhum show hoje');
  });

  describe('setores deste portão', () => {
    const sectorChips = () => [
      ...element().querySelectorAll<HTMLButtonElement>('[aria-label="Setores atendidos"] button'),
    ];

    async function withSectors() {
      await render([show('s1', 'Banda A')]);
      http.expectOne('/api/v1/shows/s1').flush({
        id: 's1',
        sectors: [
          { id: PISTA, name: 'Pista' },
          { id: CAMAROTE, name: 'Camarote' },
        ],
      });
      await settle();
      fixture.detectChanges();
      setGate('Portão B');
    }

    it('por padrão, o portão atende todos', async () => {
      await withSectors();
      expect(sectorChips().map((chip) => chip.textContent!.trim())).toEqual([
        'Todos',
        'Pista',
        'Camarote',
      ]);
      expect(sectorChips()[0].getAttribute('aria-pressed')).toBe('true');
      submit().click();
      expect(navigate).toHaveBeenCalledWith(['/portaria/shows', 's1'], {
        queryParams: { portao: 'Portão B' },
      });
    });

    it('escolhe os setores, guarda no aparelho e leva ao leitor', async () => {
      await withSectors();
      sectorChips()[2].click();
      fixture.detectChanges();
      expect(sectorChips()[0].getAttribute('aria-pressed')).toBe('false');
      expect(sectorChips()[2].getAttribute('aria-pressed')).toBe('true');
      submit().click();
      expect(settings.sectorsFor('s1')).toEqual([CAMAROTE]);
      expect(navigate).toHaveBeenCalledWith(['/portaria/shows', 's1'], {
        queryParams: { portao: 'Portão B', setores: CAMAROTE },
      });
      // "Todos" desfaz a escolha.
      sectorChips()[0].click();
      fixture.detectChanges();
      expect(sectorChips()[2].getAttribute('aria-pressed')).toBe('false');
    });
  });

  it('sem conexão, mostra os shows com a lista guardada no aparelho', async () => {
    await db.savePackage({
      showId: 's1',
      savedAt: '2026-12-16T23:31:00Z',
      pkg: testPackage('chave'),
      show: show('s1', 'Banda Guardada'),
    });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: GATE_OFFLINE_DB, useValue: db },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GateSetupPage);
    fixture.detectChanges();
    http.expectOne('/api/v1/checkins/shows').error(new ProgressEvent('error'));
    await settle();
    fixture.detectChanges();
    expect(element().querySelector('.stored')?.textContent).toContain('guardada neste aparelho');
    expect(element().textContent).toContain('Banda Guardada');
    // Os setores vêm do pacote guardado.
    http.expectOne('/api/v1/shows/s1').error(new ProgressEvent('error'));
    await settle();
    fixture.detectChanges();
    expect(element().querySelector('[aria-label="Setores atendidos"]')?.textContent).toContain(
      'Camarote',
    );
  });
});
