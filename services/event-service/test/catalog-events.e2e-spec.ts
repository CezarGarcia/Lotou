import { getModelToken } from '@nestjs/mongoose';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Model } from 'mongoose';
import { OutboxMessage } from '../src/outbox/outbox.schema.js';
import { republishCatalog } from '../src/shows/catalog-republish.js';
import { Show } from '../src/shows/show.schema.js';
import { ShowsService } from '../src/shows/shows.service.js';
import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import { contractErrors } from './support/contracts.js';
import {
  createPublishedShow,
  createShow,
  createVenue,
  showAt,
  type VenueBody,
} from './support/fixtures.js';
import { type ReadMessage, TopicReader } from './support/kafka.js';

const RELAY_ON = { OUTBOX_RELAY_ENABLED: 'true' };

const versionsOf = (messages: ReadMessage[]) =>
  messages.map((m) => m.value.payload.version as number);

const expectValid = (messages: ReadMessage[]) => {
  for (const { value } of messages) {
    expect(
      contractErrors('shows.catalog', value.type as string, value),
    ).toEqual([]);
  }
};

describe('Catálogo no Kafka (shows.catalog)', () => {
  let t: TestApp;
  let producer: ApiClient;
  let venue: VenueBody;
  let reader: TopicReader;
  let outbox: Model<OutboxMessage>;

  const minutesFromNow = (minutes: number) =>
    new Date(Date.now() + minutes * 60_000);

  beforeAll(async () => {
    // O que o SDK do OpenTelemetry registra em produção: o propagador W3C e o
    // contexto que acompanha as chamadas assíncronas.
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );

    t = await createTestApp({ env: RELAY_ON });
    producer = await t.as('producer');
    venue = await createVenue(producer);
    outbox = t.app.get(getModelToken(OutboxMessage.name));
    reader = await TopicReader.start('shows.catalog');
  });
  afterAll(async () => {
    await reader.stop();
    await t.close();
    propagation.disable();
    context.disable();
  });

  it('publicar o show põe ShowPublished no tópico, conforme o contrato', async () => {
    const draft = await createShow(producer, showAt(venue));
    const published = (
      await producer.post(`/v1/shows/${draft.id}/publish`, {}, null).expect(200)
    ).body;

    const [message] = await reader.waitFor(draft.id, 1);

    expect(message.key).toBe(draft.id);
    expect(message.value).toMatchObject({
      type: 'ShowPublished',
      version: 1,
      payload: {
        showId: draft.id,
        version: published.version,
        status: 'PUBLISHED',
        title: 'Turnê Horizonte',
        venue: { id: venue.id, name: 'Arena Lotou' },
      },
    });
    expectValid([message]);
    // Publicada e marcada no outbox.
    expect(
      await outbox.countDocuments({ key: draft.id, publishedAt: null }),
    ).toBe(0);
  });

  it('rascunho nunca vai para o catálogo', async () => {
    const draft = await createShow(producer, showAt(venue));
    await producer
      .patch(`/v1/shows/${draft.id}`, { title: 'Ainda rascunho', version: 1 })
      .expect(200);

    expect(await outbox.countDocuments({ key: draft.id })).toBe(0);
  });

  it('edições e o job de vendas saem em ordem, com versões crescentes', async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    let version = show.version;
    for (const title of [
      'Turnê Horizonte (extra)',
      'Turnê Horizonte (final)',
    ]) {
      version = (
        await producer
          .patch(`/v1/shows/${show.id}`, { title, version })
          .expect(200)
      ).body.version;
    }
    // O job abre as vendas: também é mudança no catálogo.
    await t.app.get(ShowsService).advanceLifecycle(minutesFromNow(1));

    const messages = await reader.waitFor(show.id, 4);

    expect(messages.map((m) => m.value.type)).toEqual([
      'ShowPublished',
      'ShowUpdated',
      'ShowUpdated',
      'ShowUpdated',
    ]);
    expect(versionsOf(messages)).toEqual([2, 3, 4, 5]);
    expect(messages.map((m) => m.value.payload.status)).toEqual([
      'PUBLISHED',
      'PUBLISHED',
      'PUBLISHED',
      'ON_SALE',
    ]);
    expect(messages[2].value.payload.title).toBe('Turnê Horizonte (final)');
    // A chave decide a partição: todas as mensagens do show na mesma.
    expect(new Set(messages.map((m) => m.partition)).size).toBe(1);
    expectValid(messages);
  });

  it('o encerramento das vendas também é publicado', async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    const service = t.app.get(ShowsService);
    await service.advanceLifecycle(minutesFromNow(1));
    await service.advanceLifecycle(new Date(Date.now() + 90 * 86_400_000));

    const messages = await reader.waitFor(show.id, 3);
    expect(messages.map((m) => m.value.payload.status)).toEqual([
      'PUBLISHED',
      'ON_SALE',
      'SALES_CLOSED',
    ]);
    expect(versionsOf(messages)).toEqual([2, 3, 4]);
  });

  it('renomear o local muda a versão dos shows e publica os que saíram do rascunho', async () => {
    const own = await createVenue(producer, { name: 'Teatro Antigo' });
    const published = await createPublishedShow(producer, showAt(own));
    const draft = await createShow(producer, showAt(own));

    await producer
      .patch(`/v1/venues/${own.id}`, {
        name: 'Teatro Novo',
        version: own.version,
      })
      .expect(200);

    const messages = await reader.waitFor(published.id, 2);
    expect(messages[1].value).toMatchObject({
      type: 'ShowUpdated',
      payload: { version: 3, venue: { name: 'Teatro Novo' } },
    });
    expectValid(messages);

    // O rascunho também mudou de versão, mas não vai para o catálogo.
    const reread = (await producer.get(`/v1/shows/${draft.id}`).expect(200))
      .body;
    expect(reread).toMatchObject({
      version: 2,
      venue: { name: 'Teatro Novo' },
    });
    expect(await outbox.countDocuments({ key: draft.id })).toBe(0);
  });

  it('o trace de quem mudou o show segue no cabeçalho da mensagem', async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const request = trace.setSpanContext(ROOT_CONTEXT, {
      traceId,
      spanId: '00f067aa0ba902b7',
      traceFlags: TraceFlags.SAMPLED,
    });

    await context.with(request, () =>
      t.app.get(ShowsService).advanceLifecycle(minutesFromNow(1)),
    );

    const [, opened] = await reader.waitFor(show.id, 2);
    expect(opened.value.payload.status).toBe('ON_SALE');
    expect(opened.headers.traceparent).toMatch(
      new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`),
    );
    const stored = await outbox
      .findOne({ key: show.id, aggregateVersion: 3 })
      .lean();
    expect(stored?.headers.traceparent).toContain(traceId);
  });

  it('a republicação põe o snapshot atual de cada show no tópico', async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    const draft = await createShow(producer, showAt(venue));
    await reader.waitFor(show.id, 1);

    const count = await republishCatalog(
      t.app.get(getModelToken(Show.name)),
      outbox,
    );

    expect(count).toBeGreaterThanOrEqual(1);
    const messages = await reader.waitFor(show.id, 2);
    expect(messages[1].value).toMatchObject({
      type: 'ShowUpdated',
      payload: { showId: show.id, version: show.version },
    });
    expectValid(messages);
    expect(await outbox.countDocuments({ key: draft.id })).toBe(0);
  });

  describe('com duas instâncias', () => {
    let second: TestApp;

    beforeAll(async () => {
      second = await createTestApp({ env: RELAY_ON });
    });
    afterAll(() => second.close());

    it('só uma publica: nada repetido e tudo em ordem', async () => {
      const otherProducer = await second.as('producer');
      const otherVenue = await createVenue(otherProducer);
      const shows = await Promise.all([
        createPublishedShow(producer, showAt(venue)),
        createPublishedShow(otherProducer, showAt(otherVenue)),
        createPublishedShow(producer, showAt(venue)),
      ]);
      const clients = [producer, otherProducer, producer];

      // Edições intercaladas nas duas instâncias.
      await Promise.all(
        shows.map(async (show, i) => {
          let version = show.version;
          for (let edit = 1; edit <= 5; edit++) {
            version = (
              await clients[i]
                .patch(`/v1/shows/${show.id}`, {
                  title: `Edição ${edit}`,
                  version,
                })
                .expect(200)
            ).body.version;
          }
        }),
      );

      for (const show of shows) {
        const messages = await reader.waitFor(show.id, 6);
        expect(versionsOf(messages)).toEqual([2, 3, 4, 5, 6, 7]);
      }
      // Um tempo para alguma repetição aparecer, se houvesse.
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const show of shows) {
        expect(versionsOf(reader.of(show.id))).toEqual([2, 3, 4, 5, 6, 7]);
      }
    });
  });
});
