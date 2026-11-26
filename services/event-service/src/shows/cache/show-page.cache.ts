import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Redis } from 'ioredis';
import type { Model } from 'mongoose';
import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { AuthenticatedUser } from '../../auth/authenticated-user.js';
import { CacheMetrics, type CacheResult } from '../../cache/cache-metrics.js';
import { LocalCache } from '../../cache/local-cache.js';
import { Problems } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { REDIS_CACHE } from '../../redis/redis.client.js';
import { RedisLock } from '../../redis/redis-lock.js';
import { isVisibleTo } from '../show-rules.js';
import { toShowResponse } from '../show.response.js';
import { Show } from '../show.schema.js';

const keyOf = (id: string) => `cache:event:${id}`;
const lockKeyOf = (id: string) => `cache:lock:event:${id}`;

/**
 * Valor do cache negativo: o show não existe ou é rascunho, ou seja, quem
 * não está autenticado recebe 404. Nunca é JSON, então não se confunde com
 * uma página.
 */
export const NOT_FOUND = 'not-found';

// TTLs da seção "Estratégia de cache e Redis" de docs/projeto.md.
const TTL_SECONDS = 600;
// Sem jitter, os shows carregados juntos (depois de um deploy, por exemplo)
// expirariam todos no mesmo segundo e voltariam ao MongoDB de uma vez.
const TTL_JITTER_SECONDS = 60;
const NEGATIVE_TTL_SECONDS = 30;
const LOCAL_TTL_MS = 2_000;
const LOCAL_MAX_ENTRIES = 1_000;

// Proteção contra stampede: o lock dura mais que uma leitura normal do
// MongoDB; quem espera desiste antes de o lock expirar.
const LOCK_TTL_MS = 2_000;
const POLL_INTERVAL_MS = 50;
const POLL_TIMEOUT_MS = 1_000;

const SECOND_DELETE_DELAY_MS = 500;

/** Como a busca no cache terminou, antes de responder a requisição. */
type Lookup =
  | {
      kind: 'cached';
      body: string;
      result: Extract<CacheResult, 'hit' | 'l1_hit'>;
    }
  /** Esta requisição pegou o lock e carrega o show do MongoDB. */
  | { kind: 'locked'; token: string }
  /** Outra requisição segurou o lock e não encheu o cache a tempo. */
  | { kind: 'timed-out' }
  | { kind: 'unavailable' };

/**
 * Cache-aside da página do show (`GET /v1/shows/:id`), em dois níveis: L1 na
 * memória do processo (2 s) e L2 no `redis-cache` (10 min + jitter).
 *
 * O cache guarda a visão de quem não está autenticado, já serializada: o JSON
 * da `ShowResponse` de um show publicado, ou `NOT_FOUND` por 30 s (cache
 * negativo). Um rascunho nunca entra como página; o dono o lê sempre do
 * MongoDB.
 *
 * Com o Redis fora ou lento, a leitura vai ao MongoDB: o cache nunca derruba
 * uma leitura.
 */
@Injectable()
export class ShowPageCache implements OnApplicationShutdown {
  private readonly logger = new Logger(ShowPageCache.name);
  private readonly local = new LocalCache<string>(
    LOCAL_TTL_MS,
    LOCAL_MAX_ENTRIES,
  );
  private readonly lock: RedisLock;
  private readonly enabled: boolean;
  private readonly pendingDeletes = new Set<NodeJS.Timeout>();

  constructor(
    @InjectModel(Show.name) private readonly shows: Model<Show>,
    @Inject(REDIS_CACHE) private readonly redis: Redis,
    private readonly metrics: CacheMetrics,
    config: ConfigService<Env, true>,
  ) {
    this.lock = new RedisLock(redis);
    this.enabled = config.get('SHOW_CACHE_ENABLED', { infer: true });
  }

  /** O corpo JSON da página do show, como `user` o enxerga. */
  async get(id: string, user?: AuthenticatedUser): Promise<string> {
    if (!this.enabled) {
      return this.fromDatabase(id, user);
    }

    const found = await this.lookup(id);
    switch (found.kind) {
      case 'cached':
        return this.serve(found.body, found.result, id, user);
      case 'locked':
        this.metrics.record('event', 'miss');
        return this.reload(id, found.token, user);
      case 'timed-out':
        this.metrics.record('event', 'miss');
        return this.fromDatabase(id, user);
      case 'unavailable':
        this.metrics.record('event', 'error');
        return this.fromDatabase(id, user);
    }
  }

  /**
   * Tira os shows do cache depois de uma escrita no MongoDB. Apaga em vez de
   * reescrever: duas escritas seguidas poderiam gravar no cache fora de
   * ordem, e a mais velha ficaria lá por 10 minutos. Apagando, a próxima
   * leitura busca o valor atual.
   *
   * Apaga de novo 500 ms depois (delayed double delete). Uma leitura que
   * buscou o show no MongoDB antes da escrita e encheu o cache depois da
   * primeira deleção deixaria o valor velho no cache; a segunda deleção o
   * remove. 500 ms cobre com folga uma leitura do MongoDB.
   *
   * O L1 das outras instâncias não é avisado e expira sozinho em até 2 s.
   */
  async evict(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.delete(ids);
    const timer = setTimeout(() => {
      this.pendingDeletes.delete(timer);
      void this.delete(ids);
    }, SECOND_DELETE_DELAY_MS);
    this.pendingDeletes.add(timer);
  }

  onApplicationShutdown(): void {
    this.pendingDeletes.forEach(clearTimeout);
  }

  /**
   * Procura no L1, depois no Redis. Se não achar, só uma requisição por show
   * fica com o lock e vai ao MongoDB (proteção contra stampede); as outras
   * esperam o valor aparecer no Redis.
   */
  private async lookup(id: string): Promise<Lookup> {
    const local = this.local.get(id);
    if (local !== undefined) {
      return { kind: 'cached', body: local, result: 'l1_hit' };
    }
    try {
      const cached = await this.redis.get(keyOf(id));
      if (cached !== null) {
        return this.remember(id, cached);
      }
      const token = await this.lock.acquire(lockKeyOf(id), LOCK_TTL_MS);
      if (!token) {
        const filled = await this.waitForFill(id);
        return filled === null
          ? { kind: 'timed-out' }
          : this.remember(id, filled);
      }
      // Quem pega o lock logo depois de outro soltá-lo encontra o cache cheio.
      const filled = await this.redis.get(keyOf(id)).catch(() => null);
      if (filled !== null) {
        await this.release(id, token);
        return this.remember(id, filled);
      }
      return { kind: 'locked', token };
    } catch (error) {
      this.logger.debug(`Leitura do cache falhou: ${String(error)}`);
      return { kind: 'unavailable' };
    }
  }

  private remember(id: string, body: string): Lookup {
    this.local.set(id, body);
    return { kind: 'cached', body, result: 'hit' };
  }

  private async waitForFill(id: string): Promise<string | null> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const filled = await this.redis.get(keyOf(id));
      if (filled !== null) {
        return filled;
      }
    }
    return null;
  }

  private async serve(
    body: string,
    result: Extract<CacheResult, 'hit' | 'l1_hit'>,
    id: string,
    user?: AuthenticatedUser,
  ): Promise<string> {
    if (body !== NOT_FOUND) {
      this.metrics.record('event', result);
      return body;
    }
    if (!user) {
      this.metrics.record('event', 'negative_hit');
      throw Problems.notFound('Show');
    }
    // O cache negativo é a visão anônima: o dono enxerga o próprio rascunho.
    this.metrics.record('event', 'miss');
    return this.fromDatabase(id, user);
  }

  /** Carrega do MongoDB e enche os dois níveis, segurando o lock. */
  private async reload(
    id: string,
    token: string,
    user?: AuthenticatedUser,
  ): Promise<string> {
    try {
      const show = await this.shows.findById(id).lean();
      const body = show && isVisibleTo(show) ? pageOf(show) : NOT_FOUND;
      await this.fill(id, body);
      return answer(show, user, body);
    } finally {
      await this.release(id, token);
    }
  }

  private async fromDatabase(
    id: string,
    user?: AuthenticatedUser,
  ): Promise<string> {
    const show = await this.shows.findById(id).lean();
    return answer(show, user);
  }

  private async fill(id: string, body: string): Promise<void> {
    this.local.set(id, body);
    const ttl =
      body === NOT_FOUND
        ? NEGATIVE_TTL_SECONDS
        : TTL_SECONDS + randomInt(TTL_JITTER_SECONDS + 1);
    try {
      await this.redis.set(keyOf(id), body, 'EX', ttl);
    } catch (error) {
      this.logger.debug(`Gravação no cache falhou: ${String(error)}`);
    }
  }

  private async release(id: string, token: string): Promise<void> {
    try {
      await this.lock.release(lockKeyOf(id), token);
    } catch (error) {
      // O TTL solta o lock sozinho.
      this.logger.debug(`Liberação do lock falhou: ${String(error)}`);
    }
  }

  private async delete(ids: readonly string[]): Promise<void> {
    ids.forEach((id) => this.local.delete(id));
    try {
      await this.redis.del(ids.map(keyOf));
    } catch (error) {
      this.logger.warn({
        msg: 'Falha ao tirar shows do cache',
        count: ids.length,
        error: String(error),
      });
    }
  }
}

const pageOf = (show: Show): string => JSON.stringify(toShowResponse(show));

/**
 * A resposta para `user`: a página, ou 404 se ele não enxerga o show. `body`
 * é a página pública já serializada, quando existe.
 */
function answer(
  show: Show | null,
  user: AuthenticatedUser | undefined,
  body?: string,
): string {
  if (!show || !isVisibleTo(show, user?.id)) {
    throw Problems.notFound('Show');
  }
  return body && body !== NOT_FOUND ? body : pageOf(show);
}
