import { envSchema } from './env.js';

const required = {
  MONGODB_URI: 'mongodb://localhost:27017/event_service',
  REDIS_CACHE_URL: 'redis://localhost:6379',
  REDIS_CORE_URL: 'redis://localhost:6380',
  AUTH_ISSUER: 'http://localhost:8180/realms/lotou',
  AUTH_JWKS_URI: 'http://localhost:8180/realms/lotou/certs',
};

describe('envSchema', () => {
  it('liga o cache e o rate limit por padrão', () => {
    expect(envSchema.parse(required)).toMatchObject({
      SHOW_CACHE_ENABLED: true,
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_MAX: 120,
      RATE_LIMIT_WINDOW_MS: 10_000,
      TRUST_PROXY: 'loopback, linklocal, uniquelocal',
    });
  });

  it('lê "false" como falso, não como texto preenchido', () => {
    const env = envSchema.parse({
      ...required,
      SHOW_CACHE_ENABLED: 'false',
      RATE_LIMIT_ENABLED: 'false',
    });
    expect(env.SHOW_CACHE_ENABLED).toBe(false);
    expect(env.RATE_LIMIT_ENABLED).toBe(false);
  });

  it.each([
    ['false', false],
    ['true', true],
    ['2', 2],
    ['10.0.0.0/8', '10.0.0.0/8'],
  ])('TRUST_PROXY=%s vira %o para o Express', (value, expected) => {
    expect(
      envSchema.parse({ ...required, TRUST_PROXY: value }).TRUST_PROXY,
    ).toBe(expected);
  });

  it('exige as duas conexões com o Redis', () => {
    const { REDIS_CORE_URL: _, ...withoutCore } = required;
    expect(envSchema.safeParse(withoutCore).success).toBe(false);
    expect(
      envSchema.safeParse({ ...required, REDIS_CACHE_URL: 'localhost:6379' })
        .success,
    ).toBe(false);
  });
});
