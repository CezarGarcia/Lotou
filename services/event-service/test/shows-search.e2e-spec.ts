import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import {
  createPublishedShow,
  createShow,
  createVenue,
  daysFromNow,
  showAt,
  type VenueBody,
} from './support/fixtures.js';

interface Summary {
  id: string;
  artist: string;
  startsAt: string;
}

describe('Busca de shows', () => {
  let t: TestApp;
  let producer: ApiClient;
  let saoPaulo: VenueBody;
  let belem: VenueBody;

  const search = async (query = ''): Promise<Summary[]> =>
    (await t.anonymous.get(`/v1/shows${query}`).expect(200)).body.items;
  const artists = async (query = '') =>
    (await search(query)).map((show) => show.artist);

  beforeAll(async () => {
    t = await createTestApp();
    producer = await t.as('producer');
    saoPaulo = await createVenue(producer);
    belem = await createVenue(producer, {
      name: 'Teatro das Mangueiras',
      address: { city: 'Belém', state: 'PA' },
      timezone: 'America/Belem',
    });

    await createPublishedShow(
      producer,
      showAt(saoPaulo, { artist: 'Marina Céu', startsAt: daysFromNow(10) }),
    );
    await createPublishedShow(
      producer,
      showAt(belem, { artist: 'Banda Maré Alta', startsAt: daysFromNow(20) }),
    );
    await createPublishedShow(
      producer,
      showAt(saoPaulo, {
        artist: 'Trio Céu Aberto',
        startsAt: daysFromNow(30),
      }),
    );
    // Rascunho: nunca aparece na busca.
    await createShow(
      producer,
      showAt(saoPaulo, {
        artist: 'Rascunho Secreto',
        startsAt: daysFromNow(15),
      }),
    );
  });
  // Aqui se testa o filtro da busca, não o cache (veja
  // show-search-cache.e2e-spec.ts): cada teste lê o MongoDB.
  beforeEach(() => t.redisCache.flushdb());
  afterAll(() => t.close());

  it('lista só os publicados, do mais próximo ao mais distante', async () => {
    expect(await artists()).toEqual([
      'Marina Céu',
      'Banda Maré Alta',
      'Trio Céu Aberto',
    ]);
  });

  it('devolve o resumo do show, com o menor preço e sem os setores', async () => {
    const [first] = (await t.anonymous.get('/v1/shows').expect(200)).body.items;
    expect(first).toEqual({
      id: expect.any(String),
      title: 'Turnê Horizonte',
      artist: 'Marina Céu',
      status: 'PUBLISHED',
      startsAt: expect.any(String),
      // Sem data agendada, as vendas abrem na publicação.
      salesStartAt: expect.any(String),
      highDemand: false,
      // Padrão quando o produtor não escolhe: a taxa de serviço é repassada ao comprador.
      serviceFeePaidBy: 'BUYER',
      venue: {
        id: saoPaulo.id,
        name: 'Arena Lotou',
        city: 'São Paulo',
        state: 'SP',
        timezone: 'America/Sao_Paulo',
      },
      priceFromCents: 12_000,
    });
  });

  it('busca por artista sem depender de acento ou de caixa', async () => {
    expect(await artists('?artist=ceu')).toEqual([
      'Marina Céu',
      'Trio Céu Aberto',
    ]);
    expect(await artists('?artist=MARÉ')).toEqual(['Banda Maré Alta']);
    expect(await artists('?artist=inexistente')).toEqual([]);
  });

  it('trata o termo de busca como texto, não como regex', async () => {
    expect(await artists('?artist=.*')).toEqual([]);
  });

  it('filtra por cidade sem depender de acento', async () => {
    expect(await artists('?city=belem')).toEqual(['Banda Maré Alta']);
    expect(await artists('?city=São Paulo&artist=trio')).toEqual([
      'Trio Céu Aberto',
    ]);
  });

  it('filtra por data usando o dia no fuso do local', async () => {
    // 22h de 31/12/2030 em São Paulo é 01h de 1º/01/2031 em UTC.
    const show = await createPublishedShow(
      producer,
      showAt(saoPaulo, {
        artist: 'Virada na Arena',
        startsAt: '2030-12-31T22:00:00-03:00',
      }),
    );

    const december = await search('?from=2030-12-31&to=2030-12-31');
    expect(december.map((s) => s.id)).toEqual([show.id]);
    expect(december[0].startsAt).toBe('2031-01-01T01:00:00.000Z');

    expect(await search('?from=2031-01-01&to=2031-01-01')).toEqual([]);
  });

  it('sem período, esconde os shows que já aconteceram', async () => {
    // Publicar exige data futura, então o show "do passado" é criado direto
    // no banco, como ficaria um show antigo.
    const { getModelToken } = await import('@nestjs/mongoose');
    const { Show } = await import('../src/shows/show.schema.js');
    const shows = t.app.get(getModelToken(Show.name));
    await shows.create({
      producerId: 'antigo',
      title: 'Show antigo',
      artist: 'Banda do Passado',
      artistSearch: 'banda do passado',
      status: 'PUBLISHED',
      startsAt: new Date('2020-05-10T23:00:00Z'),
      startsOn: '2020-05-10',
    });

    expect(await artists()).not.toContain('Banda do Passado');
    expect(await artists('?from=2020-05-01&to=2020-05-31')).toEqual([
      'Banda do Passado',
    ]);
  });

  it('pagina por cursor sem repetir nem pular shows', async () => {
    const all = await search('?limit=100');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/shows?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await t.anonymous.get(url).expect(200)).body;
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((s: Summary) => s.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);

    expect(seen).toEqual(all.map((s) => s.id));
    expect(pages).toBe(Math.ceil(all.length / 2));
  });

  it('mantém a ordem entre shows no mesmo horário', async () => {
    const startsAt = daysFromNow(45);
    for (const artist of ['Empate A', 'Empate B', 'Empate C']) {
      await createPublishedShow(
        producer,
        showAt(saoPaulo, { artist, startsAt }),
      );
    }

    const first = (
      await t.anonymous.get('/v1/shows?artist=empate&limit=2').expect(200)
    ).body;
    const second = (
      await t.anonymous
        .get(`/v1/shows?artist=empate&limit=2&cursor=${first.nextCursor}`)
        .expect(200)
    ).body;

    expect(
      [...first.items, ...second.items].map((s: Summary) => s.artist),
    ).toEqual(['Empate A', 'Empate B', 'Empate C']);
    expect(second.nextCursor).toBeNull();
  });

  it('responde 400 para parâmetro desconhecido, data inválida ou período invertido', async () => {
    for (const query of [
      '?cidade=Belém',
      '?from=31/12/2030',
      '?from=2030-12-31&to=2030-01-01',
      '?artist[$ne]=x',
      '?limit=0',
    ]) {
      const response = await t.anonymous.get(`/v1/shows${query}`).expect(400);
      expect(response.body.type).toBe('urn:lotou:problem:validation-error');
    }
  });
});
