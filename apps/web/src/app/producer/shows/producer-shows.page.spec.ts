import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { toProducerShow } from '../data/producer.api';
import { ProducerShowsPage } from './producer-shows.page';

/** Show como o analytics devolve: `showId` e o local achatado. */
const show = (id: string, extra: Record<string, unknown> = {}) => ({
  showId: id,
  title: 'Turnê Mar Aberto',
  artist: `Artista ${id}`,
  // 01h UTC do dia 1º/01 são 22h do dia 31/12 em Recife.
  startsAt: '2031-01-01T01:00:00Z',
  timezone: 'America/Recife',
  venueName: 'Arena Recife',
  city: 'Recife',
  status: 'ON_SALE',
  ticketsSold: 1240,
  revenueCents: 18_600_000,
  ...extra,
});

const plain = (text: string) => text.replace(/ /g, ' ').replace(/\s+/g, ' ');

describe('ProducerShowsPage', () => {
  let http: HttpTestingController;

  async function render() {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ProducerShowsPage);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
    };
    return { fixture, element, settle, text: () => plain(element.textContent!) };
  }

  afterEach(() => http.verify());

  it('lista os shows do produtor com data no fuso do show, vendas e receita', async () => {
    const { element, settle, text } = await render();
    const request = http.expectOne((req) => req.url === '/api/v1/analytics/shows');
    expect(request.request.params.get('limit')).toBe('20');
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush({ items: [show('a'), show('b', { status: 'DRAFT' })], nextCursor: null });
    await settle();

    const links = element.querySelectorAll<HTMLAnchorElement>('a.show');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/painel/shows/a');
    expect(text()).toContain('31/12/2030 às 22:00');
    expect(text()).toContain('Arena Recife, Recife');
    expect(text()).toContain('1.240 ingressos vendidos');
    expect(text()).toContain('R$ 186.000,00');
    expect(text()).toContain('À venda');
    expect(text()).toContain('Rascunho');
    expect(element.querySelector('.more')).toBeNull();
  });

  it('carrega a página seguinte com o cursor', async () => {
    const { element, settle } = await render();
    http.expectOne(() => true).flush({ items: [show('a')], nextCursor: 'c1' });
    await settle();

    element.querySelector<HTMLButtonElement>('.more button')!.click();
    http
      .expectOne((req) => req.params.get('cursor') === 'c1')
      .flush({
        items: [show('b')],
        nextCursor: null,
      });
    await settle();

    expect(element.querySelectorAll('a.show')).toHaveLength(2);
    expect(element.querySelector('.more')).toBeNull();
  });

  it('mostra o estado vazio', async () => {
    const { settle, text } = await render();
    http.expectOne(() => true).flush({ items: [], nextCursor: null });
    await settle();
    expect(text()).toContain('Você ainda não tem shows');
  });

  it('mostra o erro em Problem Details e tenta de novo', async () => {
    const { element, settle, text } = await render();
    http
      .expectOne(() => true)
      .flush(
        {
          type: 'urn:lotou:problem:unavailable',
          title: 'Indisponível',
          status: 503,
          detail: 'Os read models ainda estão sendo criados.',
          traceId: 'abc123',
        },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await settle();

    expect(element.querySelector('[role="alert"]')).not.toBeNull();
    expect(text()).toContain('Os read models ainda estão sendo criados.');
    expect(text()).toContain('abc123');

    element.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await settle();
    http.expectOne(() => true).flush({ items: [show('a')], nextCursor: null });
    await settle();
    expect(element.querySelectorAll('a.show')).toHaveLength(1);
  });
});

describe('toProducerShow', () => {
  it('aceita também `id` e o local como objeto venue', () => {
    const parsed = toProducerShow({
      id: 's1',
      title: 'T',
      artist: 'A',
      startsAt: '2031-01-01T01:00:00Z',
      status: 'ON_SALE',
      venue: { name: 'Arena', city: 'Recife', timezone: 'America/Recife' },
      ticketsSold: 1,
      revenueCents: 100,
    });
    expect(parsed).toMatchObject({
      venueName: 'Arena',
      city: 'Recife',
      timezone: 'America/Recife',
    });
  });

  it('sem fuso, deixa o do navegador em vez de quebrar a formatação', () => {
    expect(toProducerShow({ id: 's1' }).timezone).toBeUndefined();
  });
});
