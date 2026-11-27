import { z } from 'zod';
import { ed25519PublicKey } from '../checkin/ticket-code.js';

const milliseconds = z.coerce.number().int().min(0);

/**
 * Variáveis de ambiente do serviço. O ConfigModule valida este schema na
 * subida: com uma variável ausente ou malformada, o serviço não inicia.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3003),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /** Banco `checkin`. A senha pode vir à parte, em `DATABASE_PASSWORD`. */
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/.+/, 'Esperado postgres:// ou postgresql://'),
  /** Quando presente, vale no lugar da senha da `DATABASE_URL`. */
  DATABASE_PASSWORD: z.string().min(1).optional(),
  /** Cada leitura usa uma ou duas conexões curtas; os portões leem juntos. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(20),

  /** `redis-core`: a marca `checkin:{ticketId}` de quem entrou primeiro. */
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\/.+/, 'Esperado redis:// ou rediss://'),

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
  /** Partições de `order.events` e `shows.catalog` processadas ao mesmo tempo. */
  CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(3),
  /** Tentativas de uma mensagem que falha antes de ir para a DLT. */
  CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  /** Espera antes da segunda tentativa; dobra a cada uma, até 5 s. */
  CONSUMER_RETRY_BACKOFF_MS: milliseconds.default(200),

  /** De quanto em quanto tempo o relay procura mensagens no outbox. */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  /** De quanto em quanto tempo as leituras recusadas vão para o banco, em lote. */
  REJECTION_FLUSH_INTERVAL_MS: z.coerce.number().int().min(10).default(200),

  /**
   * Chave do HMAC do QR code (ADR 15), a mesma do order-service. Sem valor
   * padrão: a portaria não sobe sem saber conferir um ingresso.
   */
  TICKET_QR_KEY: z.string().min(16),
  /**
   * Chave pública Ed25519 do QR code `LOTOU2` (ADR 38), SPKI DER em base64: o
   * order-service assina com a privada. Vai também no pacote offline, para o
   * leitor conferir o ingresso sem internet. Sem valor padrão, como a do HMAC.
   */
  TICKET_PUBLIC_KEY: z
    .string()
    .trim()
    .refine(
      isEd25519PublicKey,
      'Esperada uma chave pública Ed25519 (SPKI DER em base64)',
    ),

  /** Quantos dias à frente a lista de shows da portaria mostra. */
  SHOWS_DAYS_AHEAD: z.coerce.number().int().min(0).max(60).default(7),

  /** Emissor esperado no JWT: a URL pública do realm no Keycloak. */
  AUTH_ISSUER: z.url(),
  /** De onde baixar as chaves públicas do realm (pode ser um endereço interno). */
  AUTH_JWKS_URI: z.url(),
  /** O token precisa ter sido emitido para esta audiência. */
  AUTH_AUDIENCE: z.string().min(1).default('lotou-api'),
});

export type Env = z.infer<typeof envSchema>;

function isEd25519PublicKey(value: string): boolean {
  try {
    ed25519PublicKey(value);
    return true;
  } catch {
    return false;
  }
}
