import { z } from 'zod';

const redisUrl = z
  .string()
  .regex(/^rediss?:\/\/.+/, 'Esperado redis:// ou rediss://');

/**
 * O `trust proxy` do Express: `true`/`false`, um número de saltos ou uma lista
 * de redes e nomes (`loopback`, `linklocal`, `uniquelocal`, CIDR).
 */
const trustProxy = z
  .string()
  .trim()
  .min(1)
  .transform((value): boolean | number | string => {
    if (value === 'true' || value === 'false') {
      return value === 'true';
    }
    return /^\d+$/.test(value) ? Number(value) : value;
  });

/**
 * Variáveis de ambiente do serviço. O ConfigModule valida este schema na
 * subida: com uma variável ausente ou malformada, o serviço não inicia.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Não é z.url(): a URI de um replica set lista vários hosts.
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\/.+/, 'Esperado mongodb:// ou mongodb+srv://'),

  /**
   * De quanto em quanto tempo os shows avançam de estado pelo horário
   * (abertura e encerramento das vendas). Zero desliga.
   */
  SHOW_LIFECYCLE_INTERVAL_MS: z.coerce.number().int().min(0).default(1000),

  /** `redis-cache`: cache da página e da busca; pode perder dados (LRU). */
  REDIS_CACHE_URL: redisUrl,
  /** `redis-core`: estado que não pode ser descartado (aqui, o rate limit). */
  REDIS_CORE_URL: redisUrl,
  /** Desliga o cache da página e da busca, para comparar no teste de carga. */
  SHOW_CACHE_ENABLED: z.stringbool().default(true),

  /** Janela deslizante das leituras do catálogo, por usuário ou por IP. */
  RATE_LIMIT_ENABLED: z.stringbool().default(true),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(100).default(10_000),
  /**
   * De quais endereços aceitar o `X-Forwarded-For`. No Compose a cadeia é
   * nginx -> gateway -> event-service, toda em rede privada: o padrão confia
   * nas redes privadas e chega ao IP real do cliente. Confiar em qualquer
   * origem deixaria o cliente escolher o próprio IP e furar o rate limit.
   */
  TRUST_PROXY: trustProxy.default('loopback, linklocal, uniquelocal'),

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
    .pipe(
      z.array(z.string().regex(/^[^:/\s]+:\d+$/, 'Esperado host:porta')).min(1),
    ),
  /**
   * Relay do outbox: publica no Kafka as mensagens gravadas junto com os
   * shows. Os testes que não precisam do Kafka o desligam.
   */
  OUTBOX_RELAY_ENABLED: z.stringbool().default(true),
  /** De quanto em quanto tempo o relay procura mensagens pendentes. */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
  /**
   * `transactional.id` do produtor do relay. É o mesmo em todas as
   * instâncias: quem assume o relay cerca (fence) o produtor da instância
   * anterior, que não consegue mais publicar.
   */
  OUTBOX_TRANSACTIONAL_ID: z.string().min(1).default('event-service-outbox'),
  /** Consumidor de `inventory.events` (apaga o cache da página do show). */
  INVENTORY_EVENTS_CONSUMER_ENABLED: z.stringbool().default(true),
  KAFKA_CONSUMER_GROUP: z.string().min(1).default('event-service'),

  /** Emissor esperado no JWT: a URL pública do realm no Keycloak. */
  AUTH_ISSUER: z.url(),
  /** De onde baixar as chaves públicas do realm (pode ser um endereço interno). */
  AUTH_JWKS_URI: z.url(),
  /** O token precisa ter sido emitido para esta audiência. */
  AUTH_AUDIENCE: z.string().min(1).default('lotou-api'),
});

export type Env = z.infer<typeof envSchema>;
