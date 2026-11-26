import { httpResource } from '@angular/common/http';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { EMPTY, catchError, distinctUntilChanged, of, retry, switchMap, tap, timer } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { AttemptKey } from '../../core/http/idempotency';
import { ApiError, isTransient, toApiError } from '../../core/http/problem';
import { cpfDigits } from '../../core/forms/cpf';
import { AvailabilityApi } from '../data/availability.api';
import { PurchaseApi } from '../data/purchase.api';
import { QueueApi } from '../data/queue.api';
import { CreateReservation, QueueStatus } from '../data/sale.models';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { countdownParts, injectNow } from '../shared/countdown';
import { injectLiveAvailability } from '../shared/live-availability';
import { PurchaseError, listPt, purchaseErrorMessage } from '../shared/purchase-errors';
import { MAX_SEATS, SeatMapState } from './seat-map.state';

/** Quantas vezes repetir sozinho quando o estoque ainda está carregando (503). */
const INVENTORY_LOADING_RETRIES = 3;

/**
 * Estado do checkout de um setor: preço do lote em venda, quantidade (pista) ou
 * cadeiras (mapa ao vivo), a reserva e todos os erros que ela pode dar.
 *
 * O preço vem da disponibilidade (o lote em venda agora), nunca do documento
 * do show: é ele que a reserva congela.
 */
@Injectable()
export class CheckoutStore {
  private readonly purchase = inject(PurchaseApi);
  private readonly availabilityApi = inject(AvailabilityApi);
  private readonly queue = inject(QueueApi);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly ids = signal<{ showId: string; sectorId: string } | null>(null);
  private readonly attempt = new AttemptKey();
  private readonly now = injectNow();

  readonly show = httpResource<Show>(() => {
    const ids = this.ids();
    return ids ? `${SHOWS_URL}/${ids.showId}` : undefined;
  });
  readonly availability = injectLiveAvailability(() => this.ids()?.showId);

  /** O setor no documento do show: nome, tipo e fileiras. */
  readonly sector = computed(() => {
    const sectorId = this.ids()?.sectorId;
    return this.show.hasValue()
      ? this.show.value().sectors.find((sector) => sector.id === sectorId)
      : undefined;
  });
  /** O setor agora: situação da venda, lote e estoque. */
  readonly live = computed(() => {
    const sectorId = this.ids()?.sectorId;
    return sectorId ? this.availability.sector(sectorId) : undefined;
  });
  readonly seated = computed(() => this.sector()?.kind === 'RESERVED_SEATING');

  /** Mapa de cadeiras, criado quando o documento do show chega. */
  readonly seatMap = computed(() => {
    const sector = this.sector();
    return sector?.kind === 'RESERVED_SEATING' ? new SeatMapState(sector.rows ?? []) : null;
  });
  readonly seatsError = signal<ApiError | null>(null);
  private readonly seatsAttempt = signal(0);

  readonly quantity = signal(1);
  readonly maxQuantity = computed(() => {
    const available = this.live()?.available;
    return Math.max(1, Math.min(MAX_SEATS, available ?? MAX_SEATS));
  });
  readonly count = computed(() =>
    this.seated() ? (this.seatMap()?.count() ?? 0) : this.quantity(),
  );
  readonly unitPriceCents = computed(() => this.live()?.lot?.priceCents ?? null);
  readonly totalCents = computed(() => {
    const unit = this.unitPriceCents();
    return unit === null ? null : unit * this.count();
  });

  /** Admissão da fila virtual (só em shows de alta demanda). */
  readonly admission = signal<QueueStatus | null>(null);
  readonly admissionLeft = computed(() => {
    const until = this.admission()?.admittedUntil;
    return until ? countdownParts(new Date(until).getTime(), this.now()) : null;
  });

  /** Aviso que não é erro: uma cadeira saiu da seleção, o limite foi atingido. */
  readonly notice = signal<string | null>(null);
  readonly error = signal<PurchaseError | null>(null);
  readonly submitting = signal(false);
  private readonly cooldownUntil = signal(0);
  /** Segundos até poder tentar de novo, depois de um 429. */
  readonly cooldown = computed(() =>
    Math.max(0, Math.ceil((this.cooldownUntil() - this.now()) / 1000)),
  );

  readonly canReserve = computed(
    () =>
      this.live()?.sale === 'ON_SALE' &&
      this.unitPriceCents() !== null &&
      this.count() > 0 &&
      !this.submitting() &&
      this.cooldown() === 0 &&
      this.admissionLeft()?.done !== true,
  );

  constructor() {
    this.followSeats();
    this.checkAdmission();
  }

  load(showId: string, sectorId: string): void {
    const current = this.ids();
    if (current?.showId !== showId || current.sectorId !== sectorId) {
      this.ids.set({ showId, sectorId });
    }
  }

  setQuantity(value: number): void {
    this.quantity.set(Math.min(this.maxQuantity(), Math.max(1, Math.round(value))));
  }

  /** Clique (ou Enter) numa cadeira do mapa. */
  toggleSeat(label: string): void {
    const result = this.seatMap()?.toggle(label);
    this.notice.set(
      result === 'limit'
        ? `Você pode escolher até ${MAX_SEATS} cadeiras por compra.`
        : result === 'unavailable'
          ? `A cadeira ${label} não está livre.`
          : null,
    );
  }

  retrySeats(): void {
    this.seatsAttempt.update((value) => value + 1);
  }

  /** Reserva os ingressos e, se der certo, abre a página da reserva para pagar. */
  reserve(cpf: string): void {
    const ids = this.ids();
    if (!ids || !this.canReserve()) {
      return;
    }
    const base = { showId: ids.showId, sectorId: ids.sectorId, cpf: cpfDigits(cpf) };
    const body: CreateReservation = this.seated()
      ? { ...base, seats: this.seatMap()!.selected() }
      : { ...base, quantity: this.quantity() };
    this.submitting.set(true);
    this.error.set(null);
    this.notice.set(null);
    this.send(body, 0);
  }

  private send(body: CreateReservation, retries: number): void {
    this.purchase
      .reserve(body, this.attempt.for(body))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (reservation) => {
          this.attempt.reset();
          this.submitting.set(false);
          void this.router.navigate(['/reservas', reservation.id]);
        },
        error: (error: unknown) => this.fail(toApiError(error), body, retries),
      });
  }

  private fail(error: ApiError, body: CreateReservation, retries: number): void {
    // Estoque carregando na abertura das vendas: tenta de novo sozinho, com a mesma chave.
    if (error.code === 'inventory-loading' && retries < INVENTORY_LOADING_RETRIES) {
      timer((error.retryAfterSeconds ?? 2) * 1000)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.send(body, retries + 1));
      return;
    }
    // Falha passageira: repetir o mesmo pedido usa a mesma chave. Resposta definitiva: chave nova.
    if (!isTransient(error)) {
      this.attempt.reset();
    }
    this.submitting.set(false);

    if (error.status === 401) {
      this.auth.login();
      return;
    }
    switch (error.code) {
      case 'queue-admission-required':
        this.goToQueue();
        return;
      case 'seat-unavailable': {
        const seats = error.details?.['seats'];
        this.seatMap()?.markUnavailable(Array.isArray(seats) ? (seats as string[]) : []);
        break;
      }
      case 'insufficient-stock': {
        const available = error.details?.['available'];
        if (typeof available === 'number' && available > 0) {
          this.quantity.set(Math.min(this.quantity(), available));
        }
        this.availability.refresh();
        break;
      }
      case 'rate-limited':
        this.cooldownUntil.set(Date.now() + (error.retryAfterSeconds ?? 5) * 1000);
        break;
      case 'sold-out':
      case 'sales-not-open':
      case 'sales-paused':
      case 'sales-closed':
        this.availability.refresh();
        break;
    }
    this.error.set({ message: purchaseErrorMessage(error), traceId: error.traceId });
  }

  /** Assina o mapa ao vivo do setor e avisa quando outra pessoa pega uma cadeira escolhida. */
  private followSeats(): void {
    const source = computed(() => {
      const ids = this.ids();
      const map = this.seatMap();
      return ids && map ? { ...ids, map, attempt: this.seatsAttempt() } : null;
    });
    toObservable(source)
      .pipe(
        switchMap((current) => {
          if (!current) {
            return EMPTY;
          }
          this.seatsError.set(null);
          return this.availabilityApi.seatFeed(current.showId, current.sectorId).pipe(
            tap((event) => {
              const lost =
                event.type === 'snapshot'
                  ? current.map.applySnapshot(event.seats)
                  : current.map.applyChange(event.change);
              if (lost.length > 0) {
                this.notice.set(
                  lost.length === 1
                    ? `A cadeira ${lost[0]} foi reservada por outra pessoa e saiu da sua seleção.`
                    : `As cadeiras ${listPt(lost)} foram reservadas por outra pessoa e saíram da sua seleção.`,
                );
              }
            }),
            catchError((error: unknown) => {
              this.seatsError.set(toApiError(error));
              return EMPTY;
            }),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe();
  }

  /**
   * Em show de alta demanda, só compra quem foi admitido pela fila. Quem não
   * foi volta para a fila; quem foi vê quanto tempo ainda tem. Se a consulta
   * falhar, segue: a API recusa a reserva sem admissão, e o erro leva à fila.
   */
  private checkAdmission(): void {
    const showId = computed(() => {
      const ids = this.ids();
      return ids && this.show.hasValue() && this.show.value().highDemand ? ids.showId : null;
    });
    toObservable(showId)
      .pipe(
        distinctUntilChanged(),
        switchMap((id) =>
          id
            ? this.queue.status(id).pipe(
                retry(1),
                catchError(() => of(null)),
              )
            : of(null),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((status) => {
        this.admission.set(status);
        if (status && status.status !== 'ADMITTED' && status.status !== 'NOT_REQUIRED') {
          this.goToQueue();
        }
      });
  }

  goToQueue(): void {
    const ids = this.ids();
    if (ids) {
      void this.router.navigate(['/shows', ids.showId, 'fila'], {
        queryParams: { setor: ids.sectorId },
        replaceUrl: true,
      });
    }
  }
}
