import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { GateSetupPage } from './gate-setup.page';
import { GateSettings } from './gate-settings';

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

  const element = () => fixture.nativeElement as HTMLElement;

  async function render(shows: object, wanted?: string) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
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
    await fixture.whenStable();
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
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GateSetupPage);
    fixture.detectChanges();
    http
      .expectOne('/api/v1/checkins/shows')
      .flush({ title: 'Fora do ar', status: 503 }, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(element().querySelector('[role="alert"]')!.textContent).toContain('Fora do ar');
    element().querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    fixture.detectChanges();
    http.expectOne('/api/v1/checkins/shows').flush([]);
    fixture.detectChanges();
    expect(element().textContent).toContain('Nenhum show hoje');
  });
});
