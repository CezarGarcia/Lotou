import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import { CacheMetrics } from '../../cache/cache-metrics.js';
import type { Page } from '../../common/pagination/cursor.js';
import { normalizeText } from '../../common/text/normalize.js';
import type { Env } from '../../config/env.js';
import { REDIS_CACHE } from '../../redis/redis.client.js';
import type { ShowSummaryResponse } from '../show.response.js';
import type { SearchShowsQuery } from '../shows.schemas.js';

const TTL_SECONDS = 60;

/**
 * A chave de uma busca: o hash da consulta já validada, numa forma canônica.
 * Consultas que dão o mesmo resultado (`?artist=Céu` e `?artist=ceu`, com ou
 * sem `limit=20`) caem na mesma chave.
 */
export function searchKey(query: SearchShowsQuery): string {
  const canonical = [
    query.artist === undefined ? null : normalizeText(query.artist),
    query.city === undefined ? null : normalizeText(query.city),
    query.from ?? null,
    query.to ?? null,
    query.limit,
    query.cursor ? [query.cursor.sortValue, query.cursor.id] : null,
  ];
  const hash = createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
  return `cache:events:${hash}`;
}

/**
 * Cache-aside da busca da loja (`GET /v1/shows`) no `redis-cache`. Sai só
 * pelo TTL de 60 s: invalidar toda busca que um show novo ou alterado poderia
 * mudar não compensa, e a loja aceita até 1 minuto de atraso na listagem. A
 * página do show, essa sim, é apagada a cada escrita.
 *
 * Com o Redis fora ou lento, a busca vai direto ao MongoDB.
 */
@Injectable()
export class ShowSearchCache {
  private readonly logger = new Logger(ShowSearchCache.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(REDIS_CACHE) private readonly redis: Redis,
    private readonly metrics: CacheMetrics,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('SHOW_CACHE_ENABLED', { infer: true });
  }

  /** O corpo JSON da página de resultados. */
  async get(
    query: SearchShowsQuery,
    search: () => Promise<Page<ShowSummaryResponse>>,
  ): Promise<string> {
    if (!this.enabled) {
      return JSON.stringify(await search());
    }

    const key = searchKey(query);
    let cached: string | null;
    try {
      cached = await this.redis.get(key);
    } catch (error) {
      this.logger.debug(`Leitura do cache falhou: ${String(error)}`);
      this.metrics.record('events', 'error');
      return JSON.stringify(await search());
    }
    if (cached !== null) {
      this.metrics.record('events', 'hit');
      return cached;
    }

    this.metrics.record('events', 'miss');
    const body = JSON.stringify(await search());
    try {
      await this.redis.set(key, body, 'EX', TTL_SECONDS);
    } catch (error) {
      this.logger.debug(`Gravação no cache falhou: ${String(error)}`);
    }
    return body;
  }
}
