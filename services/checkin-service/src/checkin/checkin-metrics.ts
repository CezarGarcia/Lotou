import { Injectable } from '@nestjs/common';
import { type Counter, type Histogram, metrics } from '@opentelemetry/api';
import type { CheckinResult } from './checkin-result.js';
import type { ConflictKind, OfflineOutcome } from './offline-scan.js';

/**
 * Métricas da portaria (docs/projeto.md, "Métricas de negócio"). Usa a API do
 * OpenTelemetry; sem o SDK (testes), não faz nada.
 *
 * - `checkins_total{gate, result}`: cada leitura, liberada ou recusada; é a
 *   base do painel "Portaria ao vivo" (entradas por minuto e por portão,
 *   leituras recusadas).
 * - `checkin_duration_seconds{result}`: quanto a leitura levou dentro do
 *   serviço, para a meta de p99 abaixo de 200 ms.
 * - `checkin_offline_scans_total{outcome}`: leituras feitas sem internet e
 *   enviadas depois (ADR 38), pelo que aconteceu com elas; uma leitura
 *   reenviada não conta de novo.
 * - `checkin_offline_conflicts_total{kind}`: quem entrou offline com um
 *   ingresso que não valia (já usado, cancelado, desconhecido, de outro show).
 */
@Injectable()
export class CheckinMetrics {
  private readonly meter = metrics.getMeter('lotou.checkin-service');

  private readonly checkins: Counter = this.meter.createCounter(
    'checkins_total',
    { description: 'Leituras de QR code na portaria, por portão e resultado' },
  );

  private readonly duration: Histogram = this.meter.createHistogram(
    'checkin_duration_seconds',
    {
      description: 'Duração da leitura do QR code, do pedido à resposta',
      unit: 's',
      advice: {
        explicitBucketBoundaries: [
          0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2.5,
        ],
      },
    },
  );

  private readonly dropped: Counter = this.meter.createCounter(
    'checkin_rejections_dropped_total',
    {
      description:
        'Recusas descartadas porque o banco ficou fora tempo demais para gravá-las',
    },
  );

  private readonly offlineScans: Counter = this.meter.createCounter(
    'checkin_offline_scans_total',
    {
      description:
        'Leituras feitas sem internet e enviadas depois, pelo resultado da sincronização',
    },
  );

  private readonly offlineConflicts: Counter = this.meter.createCounter(
    'checkin_offline_conflicts_total',
    {
      description:
        'Entradas offline com ingresso que não valia: já usado, cancelado, desconhecido ou de outro show',
    },
  );

  record(gate: string, result: CheckinResult, seconds: number): void {
    this.checkins.add(1, { gate, result });
    this.duration.record(seconds, { result });
  }

  rejectionsDropped(count: number): void {
    this.dropped.add(count);
  }

  offlineScan(outcome: OfflineOutcome, kind: ConflictKind | null): void {
    this.offlineScans.add(1, { outcome });
    if (kind) {
      this.offlineConflicts.add(1, { kind });
    }
  }
}
