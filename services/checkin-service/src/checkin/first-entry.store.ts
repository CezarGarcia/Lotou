import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CORE } from '../redis/redis.client.js';
import type { FirstEntry } from './checkin-result.js';

/** A chave dura até bem depois do show: um dia depois do início. */
const KEEP_AFTER_START_MS = 24 * 60 * 60 * 1000;
/** E nunca menos que isto, para um show com horário errado no catálogo. */
const MIN_TTL_MS = 60 * 60 * 1000;

/**
 * Por quanto tempo a marca de outro portão vale como "entrada em andamento".
 * Quem marcou primeiro grava no Postgres logo em seguida; uma marca mais
 * velha que isto, de um ingresso que o banco ainda diz `VALID`, é de um
 * processo que caiu entre o Redis e o banco, e não vale mais.
 */
export const PENDING_GRACE_MS = 5_000;

export type Claim =
  /** Este portão é o primeiro: grave a entrada no Postgres. */
  | { outcome: 'claimed' }
  /** Outro portão chegou antes (ou está gravando agora). */
  | { outcome: 'taken'; entry: FirstEntry }
  /** Marca antiga que o banco não confirma: siga pelo banco. */
  | { outcome: 'stale'; entry: FirstEntry }
  /** Redis fora ou lento: siga pelo banco, que decide sozinho. */
  | { outcome: 'unavailable' };

// Apaga a marca só se ela ainda for a deste portão.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

const keyOf = (ticketId: string) => `checkin:${ticketId}`;

const encode = (entry: FirstEntry) =>
  JSON.stringify({ at: entry.at.toISOString(), gate: entry.gate });

function decode(value: string): FirstEntry | undefined {
  try {
    const parsed = JSON.parse(value) as { at?: unknown; gate?: unknown };
    const at = typeof parsed.at === 'string' ? new Date(parsed.at) : undefined;
    if (at && !Number.isNaN(at.getTime()) && typeof parsed.gate === 'string') {
      return { at, gate: parsed.gate };
    }
  } catch {
    // Valor que não é desta versão do serviço: tratado como ausente.
  }
  return undefined;
}

/**
 * `checkin:{ticketId}` no `redis-core`: o caminho rápido da corrida entre
 * portões. Um `SET NX` decide quem chegou primeiro sem passar pelo Postgres;
 * o valor guarda o horário e o portão, para o segundo leitor mostrar "já
 * utilizado às 20h31 no portão B".
 *
 * O Redis não é a palavra final: a constraint única de `checkins` é. Por isso
 * toda falha do Redis vira `unavailable`, e a leitura segue pelo banco.
 */
@Injectable()
export class FirstEntryStore {
  private readonly logger = new Logger(FirstEntryStore.name);

  constructor(@Inject(REDIS_CORE) private readonly redis: Redis) {}

  async claim(
    ticketId: string,
    entry: FirstEntry,
    showStartsAt: Date | undefined,
  ): Promise<Claim> {
    const key = keyOf(ticketId);
    try {
      const set = await this.redis.set(
        key,
        encode(entry),
        'PX',
        ttlMs(entry.at, showStartsAt),
        'NX',
      );
      if (set === 'OK') {
        return { outcome: 'claimed' };
      }
      const current = await this.redis.get(key);
      const existing = current === null ? undefined : decode(current);
      if (!existing) {
        // Sumiu (ou é ilegível) entre o SET e o GET: o banco decide.
        return { outcome: 'unavailable' };
      }
      const age = entry.at.getTime() - existing.at.getTime();
      return age > PENDING_GRACE_MS
        ? { outcome: 'stale', entry: existing }
        : { outcome: 'taken', entry: existing };
    } catch (error) {
      this.logger.warn(
        `Redis indisponível na leitura do ingresso ${ticketId}; o Postgres decide: ${(error as Error).message}`,
      );
      return { outcome: 'unavailable' };
    }
  }

  /**
   * Grava a entrada confirmada pelo banco por cima do que houver: depois de
   * uma marca velha, ou quando o Redis estava sem a chave.
   */
  async remember(
    ticketId: string,
    entry: FirstEntry,
    showStartsAt: Date | undefined,
  ): Promise<void> {
    try {
      await this.redis.set(
        keyOf(ticketId),
        encode(entry),
        'PX',
        ttlMs(entry.at, showStartsAt),
      );
    } catch (error) {
      this.logger.debug(
        `Não foi possível gravar checkin:${ticketId} no Redis: ${(error as Error).message}`,
      );
    }
  }

  /** Desfaz a marca deste portão: a entrada não foi gravada no banco. */
  async release(ticketId: string, entry: FirstEntry): Promise<void> {
    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, keyOf(ticketId), encode(entry));
    } catch (error) {
      // Fica a marca; depois de PENDING_GRACE_MS ela deixa de valer.
      this.logger.warn(
        `Não foi possível desfazer checkin:${ticketId} no Redis: ${(error as Error).message}`,
      );
    }
  }
}

/** Até um dia depois do início do show, com um mínimo de uma hora. */
export function ttlMs(now: Date, showStartsAt: Date | undefined): number {
  const untilEnd = showStartsAt
    ? showStartsAt.getTime() + KEEP_AFTER_START_MS - now.getTime()
    : 0;
  return Math.max(untilEnd, MIN_TTL_MS);
}
