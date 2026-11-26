import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Venue } from '../src/venues/venue.schema.js';
import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import { arena } from './support/fixtures.js';

describe('Idempotency-Key', () => {
  let t: TestApp;
  let producer: ApiClient;
  let venues: Model<Venue>;

  beforeAll(async () => {
    t = await createTestApp();
    producer = await t.as('producer');
    venues = t.app.get<Model<Venue>>(getModelToken(Venue.name));
  });
  afterAll(() => t.close());

  it('exige o cabeçalho em POST que cria recurso', async () => {
    const response = await producer.post('/v1/venues', arena, null).expect(400);
    expect(response.body).toMatchObject({
      type: 'urn:lotou:problem:validation-error',
      errors: [{ field: 'Idempotency-Key' }],
    });
  });

  it('devolve a mesma resposta na repetição, sem criar de novo', async () => {
    const key = randomUUID();
    const body = { ...arena, name: 'Teatro da Repetição' };

    const first = await producer.post('/v1/venues', body, key).expect(201);
    const second = await producer.post('/v1/venues', body, key).expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.headers.location).toBe(first.headers.location);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await venues.countDocuments({ name: body.name })).toBe(1);
  });

  it('cria um único recurso com 20 requisições simultâneas da mesma chave', async () => {
    const key = randomUUID();
    const body = { ...arena, name: 'Teatro do Clique Duplo' };

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => producer.post('/v1/venues', body, key)),
    );

    // Quem chegou durante o processamento recebe 409; quem chegou depois
    // recebe a resposta original. Ninguém cria um segundo local.
    const created = responses.filter((r) => r.status === 201);
    const inProgress = responses.filter((r) => r.status === 409);
    expect(created.length + inProgress.length).toBe(20);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
    for (const response of inProgress) {
      expect(response.body.type).toBe('urn:lotou:problem:request-in-progress');
    }
    expect(await venues.countDocuments({ name: body.name })).toBe(1);
  });

  it('responde 422 para a mesma chave com outro corpo', async () => {
    const key = randomUUID();
    await producer.post('/v1/venues', arena, key).expect(201);
    const response = await producer
      .post('/v1/venues', { ...arena, name: 'Outro corpo' }, key)
      .expect(422);

    expect(response.body.type).toBe('urn:lotou:problem:idempotency-key-reused');
  });

  it('isola a chave por usuário', async () => {
    const key = randomUUID();
    const other = await t.as('producer');

    const mine = await producer.post('/v1/venues', arena, key).expect(201);
    const theirs = await other.post('/v1/venues', arena, key).expect(201);

    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(theirs.headers['idempotent-replayed']).toBeUndefined();
  });

  it('libera a chave quando a requisição falha, para o cliente corrigir', async () => {
    const key = randomUUID();
    await producer
      .post('/v1/venues', { ...arena, timezone: 'Lua/Cratera' }, key)
      .expect(400);
    await producer.post('/v1/venues', arena, key).expect(201);
  });
});
