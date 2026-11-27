import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { envSchema } from './env.js';

const spkiOf = ({ publicKey }: { publicKey: KeyObject }) =>
  publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const required = {
  DATABASE_URL: 'postgres://checkin@localhost:5432/checkin',
  REDIS_URL: 'redis://localhost:6380',
  TICKET_QR_KEY: 'lotou-dev-ticket-qr-key',
  TICKET_PUBLIC_KEY: spkiOf(generateKeyPairSync('ed25519')),
  AUTH_ISSUER: 'http://localhost:8180/realms/lotou',
  AUTH_JWKS_URI:
    'http://localhost:8180/realms/lotou/protocol/openid-connect/certs',
};

describe('envSchema', () => {
  it('preenche os padrões', () => {
    expect(envSchema.parse(required)).toMatchObject({
      PORT: 3003,
      KAFKA_BROKERS: ['localhost:9094'],
      AUTH_AUDIENCE: 'lotou-api',
      CONSUMER_MAX_ATTEMPTS: 5,
      REJECTION_FLUSH_INTERVAL_MS: 200,
      SHOWS_DAYS_AHEAD: 7,
    });
  });

  it('lê a lista de brokers separada por vírgula', () => {
    const env = envSchema.parse({
      ...required,
      KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092',
    });
    expect(env.KAFKA_BROKERS).toEqual(['kafka-1:9092', 'kafka-2:9092']);
  });

  it.each(Object.keys(required))('exige %s', (name) => {
    const env: Record<string, string> = { ...required };
    delete env[name];
    expect(envSchema.safeParse(env).success).toBe(false);
  });

  it('recusa chave do QR curta demais', () => {
    expect(
      envSchema.safeParse({ ...required, TICKET_QR_KEY: 'curta' }).success,
    ).toBe(false);
  });

  it('recusa chave pública que não é Ed25519 em SPKI base64', () => {
    for (const TICKET_PUBLIC_KEY of [
      'abc',
      'não é base64',
      spkiOf(generateKeyPairSync('x25519')),
    ]) {
      expect(
        envSchema.safeParse({ ...required, TICKET_PUBLIC_KEY }).success,
      ).toBe(false);
    }
  });

  it('recusa conexões em formato errado', () => {
    expect(
      envSchema.safeParse({ ...required, DATABASE_URL: 'localhost:5432/x' })
        .success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...required, REDIS_URL: 'localhost:6380' }).success,
    ).toBe(false);
  });
});
