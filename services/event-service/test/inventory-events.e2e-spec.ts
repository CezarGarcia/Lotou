import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { v7 as uuidv7 } from 'uuid';
import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import { contractExample } from './support/contracts.js';
import {
  createPublishedShow,
  createVenue,
  showAt,
  type VenueBody,
} from './support/fixtures.js';
import { produce, TopicReader } from './support/kafka.js';

/** O exemplo do contrato, com outro show e um eventId novo. */
const lotEvent = (type: 'LotSoldOut' | 'LotOpened', showId: string) => {
  const example = contractExample('inventory.events', type);
  return {
    ...example,
    eventId: uuidv7(),
    payload: { ...(example.payload as object), showId },
  };
};

describe('Eventos do inventory (inventory.events)', () => {
  let t: TestApp;
  let producer: ApiClient;
  let venue: VenueBody;
  let dlt: TopicReader;

  const cacheKey = (id: string) => `cache:event:${id}`;

  /**
   * Publica o show e abre a página, para ela entrar no cache. Espera antes a
   * segunda deleção da publicação (500 ms), que senão apagaria a chave no
   * lugar do evento.
   */
  const cachedShow = async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    await sleep(700);
    await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
    expect(await t.redisCache.exists(cacheKey(show.id))).toBe(1);
    return show;
  };

  const waitUntilEvicted = async (id: string, timeoutMs = 25_000) => {
    const deadline = Date.now() + timeoutMs;
    while (await t.redisCache.exists(cacheKey(id))) {
      if (Date.now() > deadline) {
        throw new Error(`O cache de ${id} não foi apagado`);
      }
      await sleep(50);
    }
  };

  beforeAll(async () => {
    t = await createTestApp({
      env: { INVENTORY_EVENTS_CONSUMER_ENABLED: 'true' },
    });
    producer = await t.as('producer');
    venue = await createVenue(producer);
    dlt = await TopicReader.start('inventory.events.dlt');
  });
  afterAll(async () => {
    await dlt.stop();
    await t.close();
  });

  it.each(['LotSoldOut', 'LotOpened'] as const)(
    '%s apaga o cache da página do show',
    async (type) => {
      const show = await cachedShow();

      await produce('inventory.events', [
        { key: show.id, value: lotEvent(type, show.id) },
      ]);

      await waitUntilEvicted(show.id);
      // A próxima leitura recarrega do MongoDB e enche o cache de novo.
      await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
      expect(await t.redisCache.exists(cacheKey(show.id))).toBe(1);
    },
    30_000,
  );

  it('ignora o que não trata e segue a partição', async () => {
    const show = await cachedShow();
    const reservation = contractExample(
      'inventory.events',
      'ReservationConfirmed',
    );

    // Mesma chave, mesma partição: o LotSoldOut só é lido depois dos outros.
    await produce('inventory.events', [
      {
        key: show.id,
        value: {
          ...reservation,
          eventId: uuidv7(),
          payload: { ...(reservation.payload as object), showId: show.id },
        },
      },
      {
        key: show.id,
        value: {
          eventId: uuidv7(),
          type: 'LotRepriced',
          version: 1,
          payload: {},
        },
      },
      { key: show.id, value: lotEvent('LotSoldOut', show.id) },
    ]);

    await waitUntilEvicted(show.id);
    expect(dlt.of(show.id)).toEqual([]);
  }, 30_000);

  it('a mensagem repetida só apaga a chave de novo', async () => {
    const show = await cachedShow();
    const event = lotEvent('LotOpened', show.id);

    await produce('inventory.events', [{ key: show.id, value: event }]);
    await waitUntilEvicted(show.id);
    await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
    await produce('inventory.events', [{ key: show.id, value: event }]);

    await waitUntilEvicted(show.id);
    expect(dlt.of(show.id)).toEqual([]);
  }, 30_000);

  it('uma mensagem malformada vai para a DLT, com a origem nos cabeçalhos', async () => {
    const key = randomUUID();
    const broken = {
      ...lotEvent('LotSoldOut', key),
      payload: { showId: 'não é um uuid' },
    };

    await produce('inventory.events', [
      {
        key,
        value: broken,
        headers: {
          traceparent:
            '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
      },
    ]);

    const [dead] = await dlt.waitFor(key, 1, 25_000);
    expect(dead.value).toEqual(broken);
    expect(dead.headers).toMatchObject({
      'kafka_dlt-original-topic': 'inventory.events',
      'kafka_dlt-original-consumer-group': process.env.KAFKA_CONSUMER_GROUP,
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(dead.headers['kafka_dlt-original-offset']).toMatch(/^\d+$/);
    expect(dead.headers['kafka_dlt-exception-message']).toMatch(
      /Payload inválido/,
    );
  }, 30_000);
});
