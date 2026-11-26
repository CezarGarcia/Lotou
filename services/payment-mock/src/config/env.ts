import { z } from 'zod';

/** Probabilidade entre 0 e 1 (0 nunca acontece, 1 sempre). */
const rate = z.coerce.number().min(0).max(1);
const milliseconds = z.coerce.number().int().min(0);

/**
 * Variáveis de ambiente do serviço. O ConfigModule valida este schema na
 * subida: com uma variável ausente ou malformada, o serviço não inicia.
 */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    /** Banco `payments`. A senha pode vir à parte, em `DATABASE_PASSWORD`. */
    DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\/.+/, 'Esperado postgres:// ou postgresql://'),
    /** Quando presente, vale no lugar da senha da `DATABASE_URL`. */
    DATABASE_PASSWORD: z.string().min(1).optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    /** Brokers do Kafka, separados por vírgula. */
    KAFKA_BROKERS: z
      .string()
      .default('localhost:9094')
      .transform((value) =>
        value
          .split(',')
          .map((broker) => broker.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().regex(/^[^:\s]+:\d+$/)).min(1)),
    /** Partições de `payment.commands` processadas ao mesmo tempo. */
    CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(3),
    /** Tentativas de um comando que falha antes de ir para a DLT. */
    CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    /** Espera antes da segunda tentativa; dobra a cada uma, até 5 s. */
    CONSUMER_RETRY_BACKOFF_MS: milliseconds.default(200),

    /** De quanto em quanto tempo o relay procura mensagens no outbox. */
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),

    /** Fração dos pagamentos recusados (0,3 é o experimento de caos). */
    DECLINE_RATE: rate.default(0),
    /** Fração dos estornos que falham. */
    REFUND_FAILURE_RATE: rate.default(0),
    /** Latência simulada do gateway, sorteada entre o mínimo e o máximo. */
    LATENCY_MIN_MS: milliseconds.default(20),
    LATENCY_MAX_MS: milliseconds.default(100),
  })
  .refine((env) => env.LATENCY_MIN_MS <= env.LATENCY_MAX_MS, {
    message: 'LATENCY_MIN_MS não pode ser maior que LATENCY_MAX_MS',
    path: ['LATENCY_MIN_MS'],
  });

export type Env = z.infer<typeof envSchema>;
