import { envSchema } from './env.js';

const required = {
  DATABASE_URL: 'postgres://payments@localhost:5432/payments',
};

describe('envSchema', () => {
  it('aprova tudo, sem latência alta, por padrão', () => {
    expect(envSchema.parse(required)).toMatchObject({
      PORT: 3002,
      KAFKA_BROKERS: ['localhost:9094'],
      DECLINE_RATE: 0,
      REFUND_FAILURE_RATE: 0,
      LATENCY_MIN_MS: 20,
      LATENCY_MAX_MS: 100,
      CONSUMER_MAX_ATTEMPTS: 5,
    });
  });

  it('lê a lista de brokers separada por vírgula', () => {
    const env = envSchema.parse({
      ...required,
      KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092',
    });
    expect(env.KAFKA_BROKERS).toEqual(['kafka-1:9092', 'kafka-2:9092']);
  });

  it.each(['-0.1', '1.5', 'trinta'])(
    'recusa DECLINE_RATE=%s, fora de 0 a 1',
    (value) => {
      expect(
        envSchema.safeParse({ ...required, DECLINE_RATE: value }).success,
      ).toBe(false);
    },
  );

  it('aceita a taxa do experimento de caos', () => {
    expect(
      envSchema.parse({ ...required, DECLINE_RATE: '0.3' }).DECLINE_RATE,
    ).toBe(0.3);
  });

  it('recusa latência mínima acima da máxima', () => {
    const result = envSchema.safeParse({
      ...required,
      LATENCY_MIN_MS: '500',
      LATENCY_MAX_MS: '100',
    });
    expect(result.success).toBe(false);
  });

  it('exige a conexão com o Postgres', () => {
    expect(envSchema.safeParse({}).success).toBe(false);
    expect(
      envSchema.safeParse({ DATABASE_URL: 'localhost:5432/payments' }).success,
    ).toBe(false);
  });

  it('recusa broker sem porta', () => {
    expect(
      envSchema.safeParse({ ...required, KAFKA_BROKERS: 'kafka' }).success,
    ).toBe(false);
  });
});
