import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  Subject,
  exhaustMap,
  filter,
  firstValueFrom,
  fromEvent,
  merge,
  switchMap,
  timer,
} from 'rxjs';
import { uuidv7 } from '../../core/http/idempotency';
import { toApiError } from '../../core/http/problem';
import { NetworkStatus } from '../../core/ui/network-status';
import {
  CheckinApi,
  CheckinResponse,
  CheckinShow,
  OFFLINE_BATCH_SIZE,
  OfflineScanResult,
} from '../data/checkin.api';
import { GateSettings } from '../gate-settings';
import { GATE_OFFLINE_DB, PendingScan, StoredPackage } from './gate-offline-db';
import { LocalEntry, checkOffline } from './offline-check';
import { OfflineTicket, doorsOpenAtOf } from './offline-package';
import { SIGNATURE_VERIFIER, parseTicketCode } from './ticket-code';

/** Com internet, o pacote do show é baixado de novo nesse intervalo. */
export const PACKAGE_REFRESH_MS = 120_000;

/** Com internet, a fila de leituras sem internet é enviada nesse intervalo. */
export const SYNC_MS = 30_000;

/**
 * Depois de uma leitura sem resposta do servidor, as seguintes são validadas
 * no aparelho por esse tempo, sem esperar outro timeout a cada pessoa da fila.
 */
export const SERVER_RETRY_MS = 30_000;

/**
 * Uma entrada dupla dentro desse tempo, no mesmo portão, é a mesma pessoa: a
 * leitura com internet chegou ao servidor, mas a resposta não voltou, e o
 * leitor validou de novo no aparelho.
 */
export const SAME_ENTRY_MS = 30_000;

/** O que o envio de uma leitura sem internet revelou, para as últimas leituras. */
export interface SyncNotice {
  result: Exclude<OfflineScanResult, { outcome: 'RECORDED' }>;
  scan: PendingScan;
  /** O ingresso no pacote, quando ele está lá (setor e lugar). */
  ticket: OfflineTicket | undefined;
}

/** O resultado de uma validação no aparelho. */
export interface LocalDecision {
  response: CheckinResponse;
  /** Abertura dos portões pela regra do pacote, para a tela dizer quando abre. */
  doorsOpenAt: string;
  timezone: string;
}

/**
 * A portaria sem internet (ADR 38), para o leitor de um show:
 *
 * - guarda no aparelho o pacote do show (a chave pública e todos os
 *   ingressos) e o atualiza a cada 2 minutos com internet;
 * - valida no aparelho quando o servidor não responde, com as entradas que
 *   o aparelho conhece (o pacote, as leituras daqui e as confirmadas online);
 * - guarda as leituras aceitas numa fila, enviada quando a rede volta (evento
 *   `online` e a cada 30 s). A primeira entrada vence; uma entrada dupla volta
 *   como conflito registrado, para a equipe saber.
 */
@Injectable()
export class GateOfflineStore {
  private readonly api = inject(CheckinApi);
  private readonly db = inject(GATE_OFFLINE_DB);
  private readonly network = inject(NetworkStatus);
  private readonly verify = inject(SIGNATURE_VERIFIER);
  private readonly settings = inject(GateSettings);
  private readonly window = inject(DOCUMENT).defaultView;

  private readonly showId = signal<string | null>(null);
  private loaded: Promise<void> = Promise.resolve();
  private tickets = new Map<string, OfflineTicket>();
  /** Entradas que este aparelho conhece no show, por ingresso. */
  private readonly entries = new Map<string, LocalEntry>();
  /** Ingressos aceitos aqui sem internet que o servidor ainda não sabe. */
  private readonly unsent = new Set<string>();
  private show: CheckinShow | null = null;
  private flushing = false;
  /** Leituras que não couberam no armazenamento do aparelho: vão da memória. */
  private readonly memoryQueue: PendingScan[] = [];

  /** O pacote guardado do show aberto. */
  readonly stored = signal<StoredPackage | null>(null);
  /** Leituras sem internet esperando o envio (de todos os shows). */
  readonly pending = signal(0);
  /** O servidor parou de responder (rede ruim mesmo com o aparelho "online"); quando. */
  private readonly serverDownAt = signal<number | null>(null);
  /** Há rede e o servidor responde. */
  readonly online = computed(() => this.network.online() && this.serverDownAt() === null);
  /** O envio voltou `401`: a sessão acabou, e a fila espera um login. */
  readonly loginNeeded = signal(false);
  /** Conflitos e recusas que o envio revelou. */
  readonly notices = new Subject<SyncNotice>();

  constructor() {
    const showId$ = toObservable(this.showId).pipe(filter((id) => id !== null));
    const online$ = this.window ? fromEvent(this.window, 'online') : EMPTY;

    showId$
      .pipe(
        switchMap((showId) =>
          merge(timer(0, PACKAGE_REFRESH_MS), online$).pipe(
            filter(() => this.network.online()),
            exhaustMap(() => this.refresh(showId)),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe();

    showId$
      .pipe(
        switchMap(() => merge(timer(0, SYNC_MS), online$)),
        takeUntilDestroyed(),
      )
      .subscribe(() => void this.flush());
  }

  /** Abre o show: lê o que o aparelho já tem e começa a atualizar e a enviar. */
  open(showId: string): void {
    if (this.showId() === showId) {
      return;
    }
    this.stored.set(null);
    this.tickets = new Map();
    this.entries.clear();
    this.unsent.clear();
    this.loaded = this.load(showId);
    this.showId.set(showId);
  }

  /** O show como a lista da portaria o descreve, para o topo do leitor sem internet. */
  remember(show: CheckinShow): void {
    if (show.showId !== this.showId()) {
      return;
    }
    this.show = show;
    const stored = this.stored();
    if (stored && JSON.stringify(stored.show) !== JSON.stringify(show)) {
      void this.keep({ ...stored, show });
    }
  }

  /** Se a leitura deve ir ao servidor primeiro (o padrão) ou ser validada aqui. */
  shouldAskServer(now = Date.now()): boolean {
    const downAt = this.serverDownAt();
    return this.network.online() && (downAt === null || now - downAt >= SERVER_RETRY_MS);
  }

  /** A leitura não teve resposta (rede, timeout, 502/503/504). */
  serverUnreachable(now = Date.now()): void {
    this.serverDownAt.set(now);
  }

  /** O servidor respondeu: volta a ser o padrão. */
  serverReachable(): void {
    this.serverDownAt.set(null);
  }

  /**
   * Ingresso aceito aqui sem internet, que o servidor ainda não recebeu.
   * Uma leitura dele com internet daria "liberada" de novo: quem decide é o
   * aparelho, até a fila ser enviada.
   */
  isUnsent(code: string): boolean {
    const ticketId = parseTicketCode(code)?.ticketId;
    return ticketId !== undefined && this.unsent.has(ticketId);
  }

  /** O servidor registrou (ou já tinha) a entrada: o aparelho passa a saber dela. */
  confirmed(ticketId: string, at: string, gate: string): void {
    const showId = this.showId();
    const known = this.entries.get(ticketId);
    if (!showId || (known && Date.parse(known.at) <= Date.parse(at))) {
      return;
    }
    const entry: LocalEntry = { showId, ticketId, at, gate };
    this.entries.set(ticketId, entry);
    void this.db.saveEntry(entry).catch(() => undefined);
  }

  /**
   * Valida no aparelho. `null` se não há pacote guardado para o show: aí não
   * há o que conferir.
   */
  async check(
    code: string,
    gate: string,
    sectors: readonly string[],
  ): Promise<LocalDecision | null> {
    await this.loaded;
    const stored = this.stored();
    const showId = this.showId();
    if (!stored || !showId) {
      return null;
    }
    const parsed = parseTicketCode(code);
    let signatureValid: boolean | null = null;
    if (parsed?.version === 2) {
      try {
        signatureValid = await this.verify(stored.pkg.publicKey, parsed.signed, parsed.signature);
      } catch {
        // Navegador sem Ed25519: vale como o LOTOU1, só se o ingresso estiver no pacote.
        signatureValid = null;
      }
    }
    const now = Date.now();
    const ticketId = parsed?.ticketId ?? '';
    const doorsOpenAt = doorsOpenAtOf(stored.pkg);
    const response = checkOffline({
      code: parsed,
      signatureValid,
      ticket: this.tickets.get(ticketId),
      entry: this.entries.get(ticketId),
      sectors,
      doorsOpenAt,
      now,
    });
    if (response.result === 'ACCEPTED') {
      const scan: PendingScan = {
        id: uuidv7(now),
        code,
        scannedAt: new Date(now).toISOString(),
        showId,
        gate,
        deviceId: this.settings.deviceId(),
        ticketId,
      };
      const entry: LocalEntry = { showId, ticketId, at: scan.scannedAt, gate };
      this.entries.set(ticketId, entry);
      this.unsent.add(ticketId);
      this.pending.update((count) => count + 1);
      // Sem espaço no aparelho: a entrada vale nesta aba, e o envio sai da memória.
      await this.db.enqueue(scan).catch(() => this.memoryQueue.push(scan));
      await this.db.saveEntry(entry).catch(() => undefined);
    }
    return { response, doorsOpenAt, timezone: stored.pkg.timezone };
  }

  /** Baixa o pacote do show e guarda no aparelho. Também diz se o servidor voltou. */
  async refresh(showId: string): Promise<void> {
    try {
      const pkg = await firstValueFrom(this.api.offlinePackage(showId));
      this.serverDownAt.set(null);
      if (pkg && pkg.showId === showId && this.showId() === showId) {
        await this.keep({
          showId,
          savedAt: new Date().toISOString(),
          pkg,
          show: this.show ?? this.stored()?.show ?? null,
        });
      }
    } catch (error) {
      this.failed(error);
    }
  }

  /**
   * Envia a fila, em lotes de até 500 por show e portão. O que voltou sai da
   * fila; uma falha deixa o resto para a próxima vez.
   */
  async flush(): Promise<void> {
    if (this.flushing || !this.network.online()) {
      return;
    }
    this.flushing = true;
    try {
      const queue = [...(await this.db.pending().catch(() => [])), ...this.memoryQueue];
      this.pending.set(queue.length);
      const showId = this.showId();
      if (queue.length === 0 && this.serverDownAt() !== null && showId) {
        // Nada a enviar, mas o servidor estava fora: a lista nova diz se ele voltou.
        await this.refresh(showId);
        return;
      }
      for (const batch of batches(queue)) {
        const [first] = batch;
        const results = await firstValueFrom(
          this.api.sendOffline({
            showId: first.showId,
            gate: first.gate,
            deviceId: first.deviceId,
            scans: batch.map(({ id, code, scannedAt }) => ({ id, code, scannedAt })),
          }),
        );
        this.serverDownAt.set(null);
        this.loginNeeded.set(false);
        await this.settle(batch, results);
      }
    } catch (error) {
      this.failed(error);
    } finally {
      this.flushing = false;
    }
  }

  private async settle(batch: PendingScan[], results: OfflineScanResult[]): Promise<void> {
    const scans = new Map(batch.map((scan) => [scan.id, scan]));
    const done: string[] = [];
    for (const result of results) {
      const scan = scans.get(result.id);
      if (!scan) {
        continue;
      }
      done.push(scan.id);
      if (scan.showId === this.showId()) {
        this.unsent.delete(scan.ticketId);
        if (result.outcome === 'DUPLICATE' && result.firstEntry) {
          this.confirmed(scan.ticketId, result.firstEntry.checkedInAt, result.firstEntry.gate);
        }
      }
      if (result.outcome !== 'RECORDED' && !sameEntry(result, scan)) {
        this.notices.next({
          result,
          scan,
          ticket: scan.showId === this.showId() ? this.tickets.get(scan.ticketId) : undefined,
        });
      }
    }
    await this.db.remove(done).catch(() => undefined);
    for (let i = this.memoryQueue.length - 1; i >= 0; i--) {
      if (done.includes(this.memoryQueue[i].id)) {
        this.memoryQueue.splice(i, 1);
      }
    }
    this.pending.update((count) => Math.max(0, count - done.length));
  }

  private async load(showId: string): Promise<void> {
    try {
      const [stored, entries, queue] = await Promise.all([
        this.db.loadPackage(showId),
        this.db.entries(showId),
        this.db.pending(),
      ]);
      if (this.showId() !== showId) {
        return;
      }
      // O pacote baixado enquanto a leitura do aparelho acontecia é mais novo.
      if (stored && !this.stored()) {
        this.use(stored);
      }
      for (const entry of entries) {
        const known = this.entries.get(entry.ticketId);
        if (!known || Date.parse(entry.at) < Date.parse(known.at)) {
          this.entries.set(entry.ticketId, entry);
        }
      }
      queue
        .filter((scan) => scan.showId === showId)
        .forEach((scan) => this.unsent.add(scan.ticketId));
      this.pending.set(queue.length);
    } catch {
      // Sem armazenamento: o leitor segue com o que baixar nesta aba.
    }
  }

  private async keep(stored: StoredPackage): Promise<void> {
    this.use(stored);
    await this.db.savePackage(stored).catch(() => undefined);
  }

  private use(stored: StoredPackage): void {
    this.tickets = new Map(stored.pkg.tickets.map((ticket) => [ticket.id, ticket]));
    this.stored.set(stored);
  }

  private failed(raw: unknown): void {
    const error = toApiError(raw);
    if (error.status === 401) {
      this.loginNeeded.set(true);
    } else if (noResponse(error.status)) {
      this.serverDownAt.set(Date.now());
    }
  }
}

/** Sem resposta do servidor: rede, gateway sem o serviço ou timeout. */
export function noResponse(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

/** A fila em lotes de até 500 leituras do mesmo show, portão e aparelho. */
export function batches(queue: readonly PendingScan[], size = OFFLINE_BATCH_SIZE): PendingScan[][] {
  const groups = new Map<string, PendingScan[]>();
  for (const scan of queue) {
    const key = `${scan.showId}|${scan.gate}|${scan.deviceId}`;
    const group = groups.get(key) ?? [];
    group.push(scan);
    groups.set(key, group);
  }
  const result: PendingScan[][] = [];
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i += size) {
      result.push(group.slice(i, i + size));
    }
  }
  return result;
}

/** O "duplicado" é a própria leitura, que chegou ao servidor sem a resposta voltar. */
function sameEntry(result: SyncNotice['result'], scan: PendingScan): boolean {
  return (
    result.outcome === 'DUPLICATE' &&
    result.firstEntry !== null &&
    result.firstEntry.gate === scan.gate &&
    Math.abs(Date.parse(result.firstEntry.checkedInAt) - Date.parse(scan.scannedAt)) <=
      SAME_ENTRY_MS
  );
}
