import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { context, trace } from '@opentelemetry/api';
import type { Pool, PoolClient } from 'pg';
import { newId } from '../common/ids.js';
import { Problems } from '../common/problem/problem.js';
import type { Env } from '../config/env.js';
import { PG_POOL } from '../database/database.module.js';
import { withTransaction } from '../database/transaction.js';
import { TOPICS } from '../kafka/topics.js';
import { type TraceHeaders, traceHeadersFrom } from '../kafka/trace-headers.js';
import { ticketCheckedIn } from '../messages/checkin-events.js';
import { enqueue } from '../outbox/outbox.repository.js';
import { OutboxRelay } from '../outbox/outbox.relay.js';
import type { TicketStatus } from '../tickets/ticket-status.js';
import { CheckinMetrics } from './checkin-metrics.js';
import type { FirstEntry, ScannedTicket } from './checkin-result.js';
import {
  findEntry,
  findScannedTicket,
  insertCheckin,
  markUsed,
} from './checkins.repository.js';
import { FirstEntryStore } from './first-entry.store.js';
import {
  type ConflictKind,
  evaluateOffline,
  inScanOrder,
  isPlausibleScanTime,
  type OfflineOutcome,
  type OfflineScan,
  type OfflineScanResult,
  type StoredOfflineScan,
  toResult,
} from './offline-scan.js';
import {
  findOfflineScans,
  findPackageShow,
  findPackageTickets,
  insertOfflineConflict,
  insertOfflineScan,
  type OfflineScanRow,
} from './offline.repository.js';
import { TicketCodeVerifier } from './ticket-code.js';

/** Um ingresso no pacote offline. */
export interface PackageTicket {
  id: string;
  sectorId: string;
  sectorName: string;
  seat: string | null;
  status: TicketStatus;
  /** Só nos já usados: a entrada que valeu, para o leitor dizer "já utilizado". */
  usedAt?: string;
  gate?: string;
}

export interface OfflinePackage {
  showId: string;
  generatedAt: string;
  /** `TICKET_PUBLIC_KEY`, SPKI DER em base64, para o WebCrypto do leitor. */
  publicKey: string;
  doorsOpenAt: string | null;
  startsAt: string;
  timezone: string;
  tickets: PackageTicket[];
}

export interface OfflineSync {
  showId: string;
  gate: string;
  deviceId: string;
  /** O `code` de cada leitura nunca vai para log nem para span. */
  scans: OfflineScan[];
}

/** A leitura já estava gravada: outro envio igual chegou antes. */
class AlreadySynced extends Error {}

/** O ingresso deixou de ser `VALID` entre a consulta e a gravação. */
class CancelledMeanwhile extends Error {}

/**
 * A portaria sem internet (ADR 38).
 *
 * - **Pacote offline:** tudo o que o leitor precisa para validar no aparelho
 *   quando o servidor não responde: a chave pública do QR, o horário do show
 *   e os ingressos, com o estado de cada um.
 * - **Sincronização:** as leituras que o aparelho aceitou sem internet chegam
 *   depois, em lote. A pessoa já entrou; não há o que recusar. A primeira
 *   entrada do ingresso é gravada como uma entrada online (Redis, `checkins`,
 *   `USED` e `TicketCheckedIn` no outbox), com o horário da leitura; as outras
 *   viram conflito registrado, com métrica e alerta.
 */
@Injectable()
export class OfflineService {
  private readonly logger = new Logger(OfflineService.name);
  private readonly publicKey: string;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly codes: TicketCodeVerifier,
    private readonly firstEntries: FirstEntryStore,
    private readonly relay: OutboxRelay,
    private readonly metrics: CheckinMetrics,
    config: ConfigService<Env, true>,
  ) {
    this.publicKey = config.get('TICKET_PUBLIC_KEY', { infer: true });
  }

  /**
   * Todos os ingressos do show, de todos os setores (o leitor filtra pelos
   * setores do portão), sem dado pessoal. `404` se o show não está na cópia
   * local do catálogo.
   */
  async offlinePackage(showId: string): Promise<OfflinePackage> {
    const span = trace.getActiveSpan();
    span?.setAttribute('lotou.show.id', showId);
    // Antes das consultas: o pacote tem pelo menos o que havia nesta hora.
    const generatedAt = new Date();
    const show = await findPackageShow(this.pool, showId);
    if (!show) {
      throw Problems.notFound('Show');
    }
    const rows = await findPackageTickets(this.pool, showId);
    span?.setAttribute('lotou.checkin.offline.tickets', rows.length);
    return {
      showId: show.show_id,
      generatedAt: generatedAt.toISOString(),
      publicKey: this.publicKey,
      doorsOpenAt: show.doors_open_at?.toISOString() ?? null,
      startsAt: show.starts_at.toISOString(),
      timezone: show.timezone,
      tickets: rows.map((row) => ({
        id: row.ticket_id,
        sectorId: row.sector_id,
        sectorName: row.sector_name,
        seat: row.seat,
        status: row.status,
        ...(row.status === 'USED' &&
          row.checked_in_at &&
          row.gate && {
            usedAt: row.checked_in_at.toISOString(),
            gate: row.gate,
          }),
      })),
    };
  }

  /**
   * Processa as leituras na ordem do horário de cada uma e responde na ordem
   * em que vieram. Uma leitura já gravada (o mesmo `id`) devolve o resultado
   * da primeira vez, sem gravar nada.
   */
  async sync(
    batch: OfflineSync,
    incoming: TraceHeaders = {},
  ): Promise<{ results: OfflineScanResult[] }> {
    const span = trace.getActiveSpan();
    span?.setAttributes({
      'lotou.show.id': batch.showId,
      'lotou.checkin.gate': batch.gate,
      'lotou.checkin.device_id': batch.deviceId,
      'lotou.checkin.offline.scans': batch.scans.length,
    });
    const requestTrace = traceHeadersFrom(incoming, context.active());
    const now = new Date();

    const results = new Map<string, OfflineScanResult>();
    const stored = await findOfflineScans(
      this.pool,
      batch.scans.map((scan) => scan.id),
    );
    for (const [id, scan] of stored) {
      results.set(id, toResult(scan));
    }

    const counts: Record<OfflineOutcome, number> = {
      RECORDED: 0,
      DUPLICATE: 0,
      CONFLICT: 0,
      REJECTED: 0,
    };
    let recorded = false;
    for (const scan of inScanOrder(batch.scans)) {
      // Já gravada antes deste envio, ou repetida dentro dele.
      if (results.has(scan.id)) {
        continue;
      }
      const outcome = await this.process(batch, scan, now, requestTrace);
      results.set(scan.id, toResult(outcome.stored));
      if (outcome.fresh) {
        counts[outcome.stored.outcome] += 1;
        this.metrics.offlineScan(outcome.stored.outcome, outcome.stored.kind);
        recorded ||= outcome.stored.outcome === 'RECORDED';
      }
    }
    if (recorded) {
      this.relay.notify();
    }

    span?.setAttributes({
      'lotou.checkin.offline.already_synced': stored.size,
      'lotou.checkin.offline.recorded': counts.RECORDED,
      'lotou.checkin.offline.duplicates': counts.DUPLICATE,
      'lotou.checkin.offline.conflicts': counts.CONFLICT,
      'lotou.checkin.offline.rejected': counts.REJECTED,
    });
    return {
      results: batch.scans.map((scan) => results.get(scan.id)!),
    };
  }

  /**
   * Uma leitura. `fresh` é `false` quando outro envio da mesma leitura gravou
   * primeiro (dois envios iguais ao mesmo tempo): o resultado é o dele.
   */
  private async process(
    batch: OfflineSync,
    scan: OfflineScan,
    now: Date,
    requestTrace: TraceHeaders,
  ): Promise<{ stored: StoredOfflineScan; fresh: boolean }> {
    const code = this.codes.verify(scan.code);
    const row: OfflineScanRow = {
      id: scan.id,
      showId: batch.showId,
      gate: batch.gate,
      deviceId: batch.deviceId,
      ticketId: code.valid ? code.ticketId : null,
      scannedAt: scan.scannedAt,
      outcome: 'REJECTED',
      kind: null,
      reason: null,
    };

    try {
      if (!isPlausibleScanTime(scan.scannedAt, now)) {
        return await this.save({ ...row, reason: 'INVALID_TIME' });
      }
      if (!code.valid) {
        // O aparelho também confere a assinatura; isto não deveria chegar.
        this.logger.warn(
          `Leitura offline com código inválido (${code.reason}) no portão ${batch.gate}, aparelho ${batch.deviceId}`,
        );
        return await this.save({ ...row, reason: 'INVALID_CODE' });
      }

      const ticket = await findScannedTicket(this.pool, code.ticketId);
      const evaluation = evaluateOffline(ticket, batch.showId);
      switch (evaluation.result) {
        case 'CONFLICT':
          return await this.conflict(row, evaluation.kind, null);
        case 'DUPLICATE':
          return await this.conflict(row, 'DUPLICATE', evaluation.entry);
        case 'ELIGIBLE':
          return await this.recordEntry(row, ticket!, requestTrace);
      }
    } catch (error) {
      if (error instanceof AlreadySynced) {
        const again = await findOfflineScans(this.pool, [scan.id]);
        return { stored: again.get(scan.id)!, fresh: false };
      }
      throw error;
    }
  }

  /**
   * A primeira entrada do ingresso, como na leitura online: a marca no Redis
   * e, numa transação, a entrada com o horário da leitura, o ingresso `USED`,
   * o `TicketCheckedIn` no outbox e a leitura em `offline_scans`. A
   * constraint única de `checkins` é a palavra final: se outra entrada foi
   * gravada antes (online, ou outra leitura offline), esta vira `DUPLICATE`.
   */
  private async recordEntry(
    row: OfflineScanRow,
    ticket: ScannedTicket,
    requestTrace: TraceHeaders,
  ): Promise<{ stored: StoredOfflineScan; fresh: boolean }> {
    const ticketId = ticket.ticketId;
    const entry: FirstEntry = { at: row.scannedAt, gate: row.gate };
    const startsAt = ticket.show?.startsAt;
    // Só para as leituras online seguintes verem o ingresso usado sem ir ao
    // banco; quem decide aqui é a constraint, mesmo com a marca de outro portão.
    const claim = await this.firstEntries.claim(ticketId, entry, startsAt);

    let outcome:
      | { result: 'RECORDED' }
      | { result: 'DUPLICATE'; entry: FirstEntry | null };
    try {
      outcome = await withTransaction(this.pool, async (client) => {
        const inserted = await insertCheckin(client, {
          id: newId(),
          ticketId,
          showId: ticket.showId,
          ...entry,
        });
        if (!inserted) {
          const first = (await findEntry(client, ticketId)) ?? null;
          await this.insertConflict(client, row, 'DUPLICATE', first);
          return { result: 'DUPLICATE' as const, entry: first };
        }
        if (!(await markUsed(client, ticketId))) {
          throw new CancelledMeanwhile();
        }
        if (
          !(await insertOfflineScan(client, { ...row, outcome: 'RECORDED' }))
        ) {
          throw new AlreadySynced();
        }
        await enqueue(client, {
          topic: TOPICS.checkinEvents,
          key: ticket.showId,
          event: ticketCheckedIn(ticket, entry.gate, entry.at),
          headers: requestTrace,
        });
        return { result: 'RECORDED' as const };
      });
    } catch (error) {
      if (claim.outcome === 'claimed') {
        await this.firstEntries.release(ticketId, entry);
      }
      if (error instanceof CancelledMeanwhile) {
        // Um TicketsCancelled chegou entre a consulta e a gravação.
        return this.conflict(row, 'CANCELLED', null);
      }
      throw error;
    }

    if (outcome.result === 'DUPLICATE') {
      if (claim.outcome === 'claimed') {
        await this.firstEntries.release(ticketId, entry);
      }
      if (outcome.entry) {
        await this.firstEntries.remember(ticketId, outcome.entry, startsAt);
      }
      this.logConflict(row, 'DUPLICATE');
      return {
        stored: this.storedOf(row, 'DUPLICATE', 'DUPLICATE', outcome.entry),
        fresh: true,
      };
    }
    if (claim.outcome !== 'claimed') {
      await this.firstEntries.remember(ticketId, entry, startsAt);
    }
    this.logger.log(
      `Ingresso ${ticketId} entrou sem internet no portão ${row.gate} (aparelho ${row.deviceId}, show ${row.showId})`,
    );
    return { stored: this.storedOf(row, 'RECORDED', null, null), fresh: true };
  }

  /** Registra o conflito e a leitura, numa transação. */
  private async conflict(
    row: OfflineScanRow,
    kind: ConflictKind,
    firstEntry: FirstEntry | null,
  ): Promise<{ stored: StoredOfflineScan; fresh: boolean }> {
    await withTransaction(this.pool, (client) =>
      this.insertConflict(client, row, kind, firstEntry),
    );
    this.logConflict(row, kind);
    const outcome = kind === 'DUPLICATE' ? 'DUPLICATE' : 'CONFLICT';
    return {
      stored: this.storedOf(row, outcome, kind, firstEntry),
      fresh: true,
    };
  }

  private async insertConflict(
    client: PoolClient,
    row: OfflineScanRow,
    kind: ConflictKind,
    firstEntry: FirstEntry | null,
  ): Promise<void> {
    const scan = {
      ...row,
      outcome: kind === 'DUPLICATE' ? ('DUPLICATE' as const) : 'CONFLICT',
      kind,
      ticketId: row.ticketId!,
    } satisfies OfflineScanRow;
    if (!(await insertOfflineScan(client, scan))) {
      throw new AlreadySynced();
    }
    await insertOfflineConflict(client, scan, firstEntry);
  }

  /** Uma recusa: só a leitura, sem conflito (a pessoa não entrou por ela). */
  private async save(
    row: OfflineScanRow,
  ): Promise<{ stored: StoredOfflineScan; fresh: boolean }> {
    await withTransaction(this.pool, async (client) => {
      if (!(await insertOfflineScan(client, row))) {
        throw new AlreadySynced();
      }
    });
    return {
      stored: this.storedOf(row, 'REJECTED', null, null),
      fresh: true,
    };
  }

  private storedOf(
    row: OfflineScanRow,
    outcome: OfflineOutcome,
    kind: ConflictKind | null,
    firstEntry: FirstEntry | null,
  ): StoredOfflineScan {
    return { id: row.id, outcome, kind, reason: row.reason, firstEntry };
  }

  private logConflict(row: OfflineScanRow, kind: ConflictKind): void {
    this.logger.warn(
      `Conflito na portaria offline (${kind}): ingresso ${row.ticketId} no portão ${row.gate}, aparelho ${row.deviceId}, show ${row.showId}`,
    );
  }
}
