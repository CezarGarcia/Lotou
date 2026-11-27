import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { defer, filter, switchMap, tap } from 'rxjs';
import { announcement } from './activity-text';
import { INITIAL_DASHBOARD, reduceDashboard } from './dashboard.state';
import { LiveDashboardClient } from './live-dashboard.client';

/**
 * Com o feed agitado (uma abertura de vendas), anunciar cada pedido tornaria
 * o leitor de tela inutilizável. O anúncio sai no máximo uma vez nesse
 * intervalo, com a contagem e a entrada mais recente.
 */
export const ANNOUNCE_EVERY_MS = 10_000;

/** Relógio da tela: tempos relativos e "atualizado há X s". */
export const CLOCK_TICK_MS = 1_000;

/**
 * Estado do painel ao vivo de um show: assina o show no WebSocket e aplica
 * cada mensagem com `reduceDashboard`. Trocar de show cancela a assinatura
 * anterior e começa do zero.
 */
@Injectable()
export class LiveShowStore {
  private readonly client = inject(LiveDashboardClient);

  private readonly showId = signal<string | null>(null);
  private readonly dashboard = signal(INITIAL_DASHBOARD);
  private readonly nowState = signal(Date.now());
  private readonly announcementState = signal('');
  private announced = { count: 0, at: Number.NEGATIVE_INFINITY };

  readonly state = this.dashboard.asReadonly();
  readonly metrics = computed(() => this.dashboard().metrics);
  readonly activity = computed(() => this.dashboard().activity);
  readonly forbidden = computed(() => this.dashboard().forbidden);
  readonly status = this.client.status;
  readonly denial = this.client.denial;
  readonly now = this.nowState.asReadonly();
  /** Texto da região ao vivo dos leitores de tela. */
  readonly announcement = this.announcementState.asReadonly();

  /** Total de ingressos ainda à venda, somando os setores. */
  readonly remaining = computed(
    () => this.metrics()?.sectors.reduce((sum, sector) => sum + sector.remaining, 0) ?? 0,
  );
  readonly capacity = computed(
    () => this.metrics()?.sectors.reduce((sum, sector) => sum + sector.capacity, 0) ?? 0,
  );

  /** Segundos desde os últimos dados deste show; `null` antes dos primeiros. */
  readonly secondsSinceUpdate = computed(() => {
    const updatedAt = this.dashboard().updatedAt;
    return updatedAt === null ? null : Math.max(0, Math.floor((this.now() - updatedAt) / 1000));
  });

  constructor() {
    toObservable(this.showId)
      .pipe(
        filter((id): id is string => id !== null),
        switchMap((id) =>
          defer(() => {
            this.dashboard.set(INITIAL_DASHBOARD);
            this.announced = { count: 0, at: Number.NEGATIVE_INFINITY };
            this.announcementState.set('');
            return this.client.watch(id);
          }),
        ),
        tap((event) => this.dashboard.update((state) => reduceDashboard(state, event, Date.now()))),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.announce());

    const clock = setInterval(() => {
      this.nowState.set(Date.now());
      this.announce();
    }, CLOCK_TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(clock));
  }

  /** Passa a acompanhar um show. */
  watch(showId: string): void {
    this.showId.set(showId);
  }

  retryNow(): void {
    this.client.retryNow();
  }

  /** Anuncia as entradas novas, respeitando o intervalo mínimo entre anúncios. */
  private announce(): void {
    const { liveCount, lastLive } = this.dashboard();
    const pending = liveCount - this.announced.count;
    const now = Date.now();
    if (pending <= 0 || now - this.announced.at < ANNOUNCE_EVERY_MS) {
      return;
    }
    this.announcementState.set(announcement(pending, lastLive));
    this.announced = { count: liveCount, at: now };
  }
}
