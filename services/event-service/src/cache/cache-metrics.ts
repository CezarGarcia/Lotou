import { Injectable } from '@nestjs/common';
import { type Counter, metrics } from '@opentelemetry/api';

/** Prefixo da chave: `event` (página do show) ou `events` (busca). */
export type CachePrefix = 'event' | 'events';

/**
 * - `l1_hit`: respondido da memória do processo;
 * - `hit`: respondido do Redis;
 * - `negative_hit`: 404 respondido do cache negativo;
 * - `miss`: foi ao MongoDB;
 * - `error`: o Redis falhou e a leitura foi ao MongoDB.
 */
export type CacheResult = 'hit' | 'l1_hit' | 'miss' | 'negative_hit' | 'error';

/**
 * `cache_requests_total{prefix, result}` (seção "Métricas de negócio" de
 * docs/projeto.md): a taxa de acerto por prefixo sai dela. Usa a API do
 * OpenTelemetry; sem o SDK (testes), não faz nada.
 */
@Injectable()
export class CacheMetrics {
  private readonly requests: Counter = metrics
    .getMeter('lotou.event')
    .createCounter('cache_requests_total', {
      description: 'Leituras com cache, por prefixo da chave e resultado',
    });

  record(prefix: CachePrefix, result: CacheResult): void {
    this.requests.add(1, { prefix, result });
  }
}
