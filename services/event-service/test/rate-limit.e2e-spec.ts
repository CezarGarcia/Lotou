import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { newId } from '../src/common/ids/id.js';
import { createTestApp, type TestApp } from './support/app.js';
import { createVenue } from './support/fixtures.js';

const MAX = 3;
const WINDOW_MS = 1_000;

describe('Rate limit das leituras do catálogo', () => {
  let t: TestApp;
  let venueId: string;

  /** Uma leitura anônima vinda do IP informado, como o gateway repassaria. */
  const fromIp = (ip: string, url = '/v1/venues') =>
    request(t.app.getHttpServer()).get(url).set('X-Forwarded-For', ip);

  beforeAll(async () => {
    t = await createTestApp({
      env: {
        RATE_LIMIT_MAX: String(MAX),
        RATE_LIMIT_WINDOW_MS: String(WINDOW_MS),
      },
    });
    venueId = (await createVenue(await t.as('producer'))).id;
  });
  // Cada teste começa com as cotas zeradas.
  beforeEach(() => t.redisCore.flushdb());
  afterAll(() => t.close());

  it('aceita o limite, recusa a requisição seguinte e libera depois da janela', async () => {
    for (let remaining = MAX - 1; remaining >= 0; remaining--) {
      const response = await fromIp('203.0.113.10').expect(200);
      expect(response.headers['ratelimit-limit']).toBe(String(MAX));
      expect(response.headers['ratelimit-remaining']).toBe(String(remaining));
    }

    const blocked = await fromIp('203.0.113.10').expect(429);
    expect(blocked.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(blocked.body).toMatchObject({
      type: 'urn:lotou:problem:rate-limited',
      status: 429,
      instance: '/v1/venues',
    });
    expect(blocked.headers['retry-after']).toBe('1');
    expect(blocked.headers['ratelimit-remaining']).toBe('0');

    await sleep(WINDOW_MS + 50);
    await fromIp('203.0.113.10').expect(200);
  });

  it('a janela desliza: cada requisição libera a cota quando sai dela', async () => {
    await fromIp('203.0.113.11').expect(200);
    await sleep(WINDOW_MS / 2);
    await fromIp('203.0.113.11').expect(200);
    await fromIp('203.0.113.11').expect(200);
    await fromIp('203.0.113.11').expect(429);

    // A primeira sai da janela; as outras duas continuam contando.
    await sleep(WINDOW_MS / 2 + 50);
    await fromIp('203.0.113.11').expect(200);
    await fromIp('203.0.113.11').expect(429);
  });

  it('conta por IP sem guardar o IP, e por usuário quando há token', async () => {
    for (let i = 0; i < MAX; i++) {
      await fromIp('203.0.113.12').expect(200);
    }
    await fromIp('203.0.113.12').expect(429);
    await fromIp('203.0.113.13').expect(200);

    // Um usuário autenticado tem a cota dele, mesmo vindo do mesmo IP.
    const token = await t.issuer.token({ sub: 'comprador-1' });
    await fromIp('203.0.113.12')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const sha256 = (ip: string) =>
      createHash('sha256').update(ip).digest('hex');
    expect((await t.redisCore.keys('rl:*')).sort()).toEqual(
      [
        `rl:ip:${sha256('203.0.113.12')}`,
        `rl:ip:${sha256('203.0.113.13')}`,
        'rl:comprador-1',
      ].sort(),
    );
  });

  it('vale para as leituras do catálogo, não para o health check', async () => {
    const urls = ['/v1/shows', `/v1/shows/${newId()}`, `/v1/venues/${venueId}`];
    for (const url of urls) {
      await t.redisCore.flushdb();
      for (let i = 0; i < MAX; i++) {
        await fromIp('203.0.113.14', url);
      }
      await fromIp('203.0.113.14', url).expect(429);
    }

    for (let i = 0; i <= MAX; i++) {
      const response = await fromIp('203.0.113.14', '/health/live').expect(200);
      expect(response.headers).not.toHaveProperty('ratelimit-limit');
    }
  });
});
