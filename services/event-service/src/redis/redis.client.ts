import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { once } from 'node:events';

/** Tokens de injeção das duas instâncias (ADR 10). */
export const REDIS_CACHE = Symbol('REDIS_CACHE');
export const REDIS_CORE = Symbol('REDIS_CORE');

/**
 * Teto de cada comando. O Redis responde em menos de 1 ms; acima disso ele
 * está lento ou fora, e quem chama segue sem ele (o cache cai no MongoDB, o
 * rate limit libera) em vez de segurar a requisição.
 */
const COMMAND_TIMEOUT_MS = 150;
const CONNECT_TIMEOUT_MS = 1_000;

/**
 * Cliente do Redis que falha rápido: sem fila offline, um comando enviado com
 * a conexão caída é recusado na hora, em vez de esperar a reconexão. A
 * reconexão continua em segundo plano.
 *
 * Espera a primeira tentativa de conexão, para a aplicação não começar a
 * atender com o cliente ainda conectando, mas não impede a subida se o Redis
 * estiver fora.
 */
export async function createRedisClient(
  url: string,
  name: string,
): Promise<Redis> {
  const logger = new Logger(`Redis(${name})`);
  const client = new Redis(url, {
    connectionName: 'event-service',
    commandTimeout: COMMAND_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 100, 2_000),
  });

  // Um aviso por queda, não um por tentativa de reconexão.
  let available = true;
  client.on('error', (error: Error) => {
    if (available) {
      available = false;
      logger.warn(`Redis indisponível: ${error.message}`);
    }
  });
  client.on('ready', () => {
    if (!available) {
      available = true;
      logger.log('Redis disponível de novo');
    }
  });

  try {
    await once(client, 'ready', {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch {
    // Segue sem o Redis; o aviso já saiu no evento `error`.
  }
  return client;
}

/** Fecha a conexão, mesmo com o Redis fora (aí só interrompe a reconexão). */
export async function closeRedisClient(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
