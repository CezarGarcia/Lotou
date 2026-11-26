import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MockInstance } from 'vitest';
import { CacheMetrics, type CacheResult } from '../src/cache/cache-metrics.js';
import { newId } from '../src/common/ids/id.js';
import { NOT_FOUND } from '../src/shows/cache/show-page.cache.js';
import { Show } from '../src/shows/show.schema.js';
import { ShowsService } from '../src/shows/shows.service.js';
import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import {
  createPublishedShow,
  createShow,
  createVenue,
  showAt,
  type VenueBody,
} from './support/fixtures.js';

const keyOf = (id: string) => `cache:event:${id}`;

/** Acompanha as leituras do MongoDB e a métrica de uma instância. */
function watch(t: TestApp) {
  const metrics = vi.spyOn(t.app.get(CacheMetrics), 'record');
  const loads = vi.spyOn(
    t.app.get<Model<Show>>(getModelToken(Show.name)),
    'findById',
  );
  return {
    loads,
    /** Os resultados da página do show, em ordem. */
    results: (): CacheResult[] =>
      (metrics as MockInstance<CacheMetrics['record']>).mock.calls
        .filter(([prefix]) => prefix === 'event')
        .map(([, result]) => result),
  };
}

describe('Cache da página do show', () => {
  // Duas instâncias do serviço no mesmo MongoDB e no mesmo Redis: o L1 é de
  // cada uma, o Redis é compartilhado.
  let t: TestApp;
  let other: TestApp;
  let producer: ApiClient;
  let venue: VenueBody;

  beforeAll(async () => {
    [t, other] = await Promise.all([createTestApp(), createTestApp()]);
    producer = await t.as('producer');
    venue = await createVenue(producer);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => Promise.all([t.close(), other.close()]));

  describe('leitura', () => {
    it('vai ao MongoDB uma vez; depois responde do L1 e, na outra instância, do Redis', async () => {
      const show = await createPublishedShow(producer, showAt(venue));
      const here = watch(t);
      const there = watch(other);

      const first = await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
      const second = await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
      const third = await other.anonymous
        .get(`/v1/shows/${show.id}`)
        .expect(200);

      expect(first.headers['content-type']).toMatch(/^application\/json/);
      expect(first.body).toMatchObject({ id: show.id, status: 'PUBLISHED' });
      expect(second.body).toEqual(first.body);
      expect(third.body).toEqual(first.body);
      expect(here.results()).toEqual(['miss', 'l1_hit']);
      expect(there.results()).toEqual(['hit']);
      expect(here.loads).toHaveBeenCalledTimes(1);
      expect(there.loads).not.toHaveBeenCalled();

      // O valor é a ShowResponse pública, com TTL de 10 min + jitter de até 60 s.
      const cached = await t.redisCache.get(keyOf(show.id));
      expect(JSON.parse(cached!)).toEqual(first.body);
      const ttl = await t.redisCache.ttl(keyOf(show.id));
      expect(ttl).toBeGreaterThan(590);
      expect(ttl).toBeLessThanOrEqual(660);
    });

    it('guarda o 404 de um show inexistente por 30 s (cache negativo)', async () => {
      const id = newId();
      const there = watch(other);

      await t.anonymous.get(`/v1/shows/${id}`).expect(404);
      expect(await t.redisCache.get(keyOf(id))).toBe(NOT_FOUND);
      const ttl = await t.redisCache.ttl(keyOf(id));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);

      const response = await other.anonymous.get(`/v1/shows/${id}`).expect(404);
      expect(response.body.type).toBe('urn:lotou:problem:not-found');
      expect(there.results()).toEqual(['negative_hit']);
      expect(there.loads).not.toHaveBeenCalled();
    });

    it('nunca guarda o rascunho; o dono o lê sempre do MongoDB', async () => {
      const draft = await createShow(producer, showAt(venue));
      const stranger = await t.as('producer');
      const here = watch(t);

      for (let i = 0; i < 2; i++) {
        const response = await producer
          .get(`/v1/shows/${draft.id}`)
          .expect(200);
        expect(response.body.status).toBe('DRAFT');
      }
      // Só a visão anônima entra no cache: 404.
      expect(await t.redisCache.get(keyOf(draft.id))).toBe(NOT_FOUND);

      await t.anonymous.get(`/v1/shows/${draft.id}`).expect(404);
      await stranger.get(`/v1/shows/${draft.id}`).expect(404);
      expect(here.results()).toEqual(['miss', 'miss', 'negative_hit', 'miss']);
      // O anônimo não foi ao banco; o dono e o outro produtor foram.
      expect(here.loads).toHaveBeenCalledTimes(3);
    });

    it('só uma de 50 requisições simultâneas vai ao MongoDB (stampede)', async () => {
      const show = await createPublishedShow(producer, showAt(venue));
      const here = watch(t);

      const responses = await Promise.all(
        Array.from({ length: 50 }, () =>
          t.anonymous.get(`/v1/shows/${show.id}`),
        ),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(50).fill(200));
      expect(new Set(responses.map((r) => r.text)).size).toBe(1);
      expect(here.loads).toHaveBeenCalledTimes(1);
      expect(here.results().filter((r) => r === 'miss')).toHaveLength(1);
      // O lock é solto assim que o cache enche.
      expect(await t.redisCache.exists(`cache:lock:event:${show.id}`)).toBe(0);
    });
  });

  describe('invalidação', () => {
    /** Lê o show, para encher o Redis e o L1. */
    const warm = async (id: string) => {
      await t.anonymous.get(`/v1/shows/${id}`).expect(200);
      expect(await t.redisCache.exists(keyOf(id))).toBe(1);
    };

    it('a alteração apaga a chave, e a leitura seguinte vê o show novo', async () => {
      const show = await createPublishedShow(producer, showAt(venue));
      await warm(show.id);

      await producer
        .patch(`/v1/shows/${show.id}`, {
          title: 'Turnê Nova',
          version: show.version,
        })
        .expect(200);

      expect(await t.redisCache.exists(keyOf(show.id))).toBe(0);
      const found = await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
      expect(found.body.title).toBe('Turnê Nova');
    });

    it('a publicação apaga o 404 guardado do rascunho', async () => {
      const draft = await createShow(producer, showAt(venue));
      await t.anonymous.get(`/v1/shows/${draft.id}`).expect(404);

      await producer
        .post(`/v1/shows/${draft.id}/publish`, {}, null)
        .expect(200);

      const found = await t.anonymous.get(`/v1/shows/${draft.id}`).expect(200);
      expect(found.body.status).toBe('PUBLISHED');
    });

    it('a abertura das vendas pelo job apaga os shows que mudaram', async () => {
      const show = await createPublishedShow(producer, showAt(venue));
      await warm(show.id);

      await t.app
        .get(ShowsService)
        .advanceLifecycle(new Date(Date.now() + 60_000));

      expect(await t.redisCache.exists(keyOf(show.id))).toBe(0);
      const found = await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
      expect(found.body.status).toBe('ON_SALE');
    });

    it('o novo nome do local apaga os shows dele', async () => {
      const place = await createVenue(producer, { name: 'Arena Antiga' });
      const shows = await Promise.all(
        [1, 2].map(() => createPublishedShow(producer, showAt(place))),
      );
      for (const show of shows) {
        await warm(show.id);
      }

      await producer
        .patch(`/v1/venues/${place.id}`, {
          name: 'Arena Rebatizada',
          version: place.version,
        })
        .expect(200);

      for (const show of shows) {
        const found = await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
        expect(found.body.venue.name).toBe('Arena Rebatizada');
      }
    });

    it('apaga de novo 500 ms depois (delayed double delete)', async () => {
      const show = await createPublishedShow(producer, showAt(venue));
      await producer
        .patch(`/v1/shows/${show.id}`, {
          title: 'Agora',
          version: show.version,
        })
        .expect(200);

      // Uma leitura que buscou o show antes da escrita e grava o valor velho
      // depois da primeira deleção.
      await t.redisCache.set(
        keyOf(show.id),
        JSON.stringify({ title: 'Antes' }),
      );
      await sleep(700);

      expect(await t.redisCache.exists(keyOf(show.id))).toBe(0);
      const found = await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
      expect(found.body.title).toBe('Agora');
    });
  });
});
