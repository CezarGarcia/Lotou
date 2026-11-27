import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { QueueApi } from '../data/queue.api';
import { QueueStatus } from '../data/sale.models';
import { QueuePage } from './queue.page';

/** O documento do show, para o cabeçalho da tela. */
const SHOW = {
  id: 's1',
  title: 'Turnê',
  artist: 'Banda',
  startsAt: '2031-01-01T01:00:00.000Z',
  venue: { id: 'v1', name: 'Arena', city: 'Recife', state: 'PE', timezone: 'America/Recife' },
  sectors: [],
};

/**
 * Deixa as respostas e os efeitos assentarem. O `whenStable` esperaria todas as
 * requisições pendentes, e o documento do show é pedido no meio do caminho.
 */
async function settle(fixture: { detectChanges(): void }) {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  fixture.detectChanges();
}

describe('QueuePage', () => {
  let events: Subject<QueueStatus>;

  async function render(first: QueueStatus) {
    events = new Subject();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: QueueApi, useValue: { join: () => of(first), events: () => events } },
      ],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(QueuePage);
    fixture.componentRef.setInput('id', 's1');
    fixture.componentRef.setInput('setor', 'pista');
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/v1/shows/s1').flush(SHOW);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    const text = () => element.textContent!.replace(/\s+/g, ' ');
    return { fixture, element, text, navigate };
  }

  it('mostra a posição e a espera, e explica o sorteio', async () => {
    const { fixture, element, text } = await render({
      showId: 's1',
      status: 'QUEUED',
      position: 1_235,
      estimatedWaitSeconds: 250,
    });
    expect(element.querySelector('.position strong')!.textContent).toBe('1.235');
    expect(text()).toContain('1.234 pessoas na sua frente.');
    expect(text()).toContain('cerca de 4 minutos');
    expect(text()).toContain('posição sorteada');

    events.next({ showId: 's1', status: 'QUEUED', position: 1 });
    await settle(fixture);
    expect(text()).toContain('Você é o próximo.');
  });

  it('enche a barra de avanço conforme a fila anda', async () => {
    const { fixture, element } = await render({ showId: 's1', status: 'QUEUED', position: 101 });
    const bar = () => element.querySelector('[role="progressbar"]')!;
    expect(bar().getAttribute('aria-valuenow')).toBe('0');

    events.next({ showId: 's1', status: 'QUEUED', position: 51 });
    await settle(fixture);
    expect(bar().getAttribute('aria-valuenow')).toBe('50');

    events.next({ showId: 's1', status: 'QUEUED', position: 1 });
    await settle(fixture);
    expect(bar().getAttribute('aria-valuenow')).toBe('100');
  });

  it('leva ao checkout do setor quando chega a vez', async () => {
    const { fixture, navigate } = await render({ showId: 's1', status: 'QUEUED', position: 2 });
    events.next({ showId: 's1', status: 'ADMITTED', admittedUntil: '2031-01-01T00:05:00Z' });
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/shows', 's1', 'comprar', 'pista'], {
      replaceUrl: true,
    });
  });

  it('oferece entrar de novo a quem perdeu a vez', async () => {
    const { element, text } = await render({ showId: 's1', status: 'NOT_IN_QUEUE' });
    expect(text()).toContain('Você não está na fila');
    expect(element.querySelector('button')!.textContent).toContain('Entrar na fila de novo');
  });
});
