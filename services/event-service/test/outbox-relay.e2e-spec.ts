import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { OutboxRelay } from '../src/outbox/outbox.relay.js';
import { OutboxLease, OutboxMessage } from '../src/outbox/outbox.schema.js';
import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import {
  createPublishedShow,
  createVenue,
  showAt,
  type VenueBody,
} from './support/fixtures.js';
import { type ReadMessage, TopicReader } from './support/kafka.js';

const versionsOf = (messages: ReadMessage[]) =>
  messages.map((m) => m.value.payload.version as number);

/**
 * O relay controlado à mão: as duas aplicações deste arquivo têm o relay
 * desligado, e os testes chamam cada passo dele para simular quedas e uma
 * instância que trava no meio de um lote.
 */
describe('Relay do outbox', () => {
  let a: TestApp;
  let b: TestApp;
  let producer: ApiClient;
  let venue: VenueBody;
  let committed: TopicReader;
  let uncommitted: TopicReader;
  let outbox: Model<OutboxMessage>;
  let leases: Model<OutboxLease>;
  let relayA: OutboxRelay;
  let relayB: OutboxRelay;

  const edit = async (id: string, version: number, title: string) =>
    (await producer.patch(`/v1/shows/${id}`, { title, version }).expect(200))
      .body.version as number;

  /** O lease vence, como se o dono tivesse travado por mais que o prazo. */
  const expireLease = () =>
    leases.updateOne({}, { $set: { expiresAt: new Date(0) } });

  /** Esvazia o outbox com o relay de `b`, para cada teste começar limpo. */
  const drain = async () => {
    await expireLease();
    while ((await relayB.relayOnce()) > 0) {
      // segue até não sobrar pendente
    }
  };

  beforeAll(async () => {
    [a, b] = await Promise.all([createTestApp(), createTestApp()]);
    producer = await a.as('producer');
    venue = await createVenue(producer);
    outbox = a.app.get(getModelToken(OutboxMessage.name));
    leases = a.app.get(getModelToken(OutboxLease.name));
    relayA = a.app.get(OutboxRelay);
    relayB = b.app.get(OutboxRelay);
    [committed, uncommitted] = await Promise.all([
      TopicReader.start('shows.catalog'),
      TopicReader.start('shows.catalog', { readUncommitted: true }),
    ]);
  });
  afterAll(async () => {
    await Promise.all([committed.stop(), uncommitted.stop()]);
    await Promise.all([a.close(), b.close()]);
  });
  beforeEach(drain);

  it('uma queda entre gravar e publicar não perde o evento', async () => {
    // A mudança e a mensagem entram juntas; ninguém publicou ainda (o
    // processo "caiu" antes do relay rodar).
    const show = await createPublishedShow(producer, showAt(venue));
    expect(
      await outbox.countDocuments({ key: show.id, publishedAt: null }),
    ).toBe(1);

    // Outra instância sobe e publica o que ficou.
    await drain();

    const [message] = await committed.waitFor(show.id, 1);
    expect(message.value).toMatchObject({
      type: 'ShowPublished',
      payload: { version: show.version },
    });
  });

  it('uma queda entre publicar e marcar repete o lote na mesma ordem', async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    await edit(show.id, show.version, 'Segunda versão');

    // Publica e "cai" antes de marcar.
    await expireLease();
    expect(await relayA.holdLease()).toBe(true);
    const plan = await relayA.nextBatch();
    await relayA.publish(plan.send);
    await committed.waitFor(show.id, 2);

    await drain();

    const messages = await committed.waitFor(show.id, 4);
    // Pelo menos uma vez: o lote sai de novo, inteiro e na mesma ordem, e a
    // última mensagem do show continua sendo a mais nova.
    expect(versionsOf(messages)).toEqual([2, 3, 2, 3]);
  });

  it('uma instância que travou no meio do lote não publica depois da nova dona', async () => {
    const show = await createPublishedShow(producer, showAt(venue));

    // A é a dona e já publicou a v2.
    await expireLease();
    expect(await relayA.relayOnce()).toBeGreaterThan(0);
    await committed.waitFor(show.id, 1);

    // Duas edições; A lê o lote (v3 e v4) e trava antes de publicar.
    let version = await edit(show.id, show.version, 'v3');
    version = await edit(show.id, version, 'v4');
    const stale = await relayA.nextBatch();
    expect(versionsOf(committed.of(show.id))).toEqual([2]);

    // O lease de A vence; B assume, publica a v3 e a v4, e depois a v5.
    await expireLease();
    expect(await relayB.relayOnce()).toBe(2);
    await edit(show.id, version, 'v5');
    expect(await relayB.relayOnce()).toBe(1);
    await committed.waitFor(show.id, 4);

    // A acorda e tenta publicar o lote velho: o broker recusa, porque B, ao
    // conectar com o mesmo transactional.id, cercou o produtor de A.
    await expect(relayA.publish(stale.send)).rejects.toThrow();

    // Nada depois da v5, nem para quem lê o que não foi confirmado.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(versionsOf(committed.of(show.id))).toEqual([2, 3, 4, 5]);
    expect(versionsOf(uncommitted.of(show.id))).toEqual([2, 3, 4, 5]);
    // E A, sem o lease, não volta a publicar.
    expect(await relayA.relayOnce()).toBe(0);
  });

  it('uma mensagem mais velha que a última publicada é descartada, não publicada', async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    const version = await edit(show.id, show.version, 'v3');
    // A v3 já saiu e foi marcada; a v2 ficou pendente (marcação pela metade).
    await outbox.updateOne(
      { key: show.id, aggregateVersion: version },
      { $set: { publishedAt: new Date() } },
    );

    await drain();

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(versionsOf(committed.of(show.id))).toEqual([]);
    expect(
      await outbox.countDocuments({ key: show.id, publishedAt: null }),
    ).toBe(0);
  });

  it('só uma instância fica com o lease', async () => {
    await expireLease();
    const held = await Promise.all([relayA.holdLease(), relayB.holdLease()]);
    expect(held.filter(Boolean)).toHaveLength(1);
    // Renovar o próprio lease continua valendo; o da outra, não.
    const owner = held[0] ? relayA : relayB;
    const other = held[0] ? relayB : relayA;
    expect(await owner.holdLease()).toBe(true);
    expect(await other.holdLease()).toBe(false);
  });
});
