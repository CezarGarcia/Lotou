import { z } from 'zod';

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

  /** Emissor esperado no JWT: a URL pública do realm no Keycloak. */
  AUTH_ISSUER: z.url(),
  /** De onde baixar as chaves públicas do realm (pode ser um endereço interno). */
  AUTH_JWKS_URI: z.url(),
  /** O token precisa ter sido emitido para esta audiência. */
  AUTH_AUDIENCE: z.string().min(1).default('lotou-api'),
});

export type Env = z.infer<typeof envSchema>;
