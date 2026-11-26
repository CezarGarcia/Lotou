import { httpResource } from '@angular/common/http';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { uuidv7 } from '../../core/http/idempotency';
import { toApiError } from '../../core/http/problem';
import { PurchaseApi, RESERVATIONS_URL } from '../data/purchase.api';
import { Reservation } from '../data/sale.models';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { countdownParts, injectNow } from '../shared/countdown';
import { PurchaseError, purchaseErrorMessage } from '../shared/purchase-errors';

/** Abaixo disso, o cronômetro fica em destaque. */
export const RESERVATION_WARNING_SECONDS = 120;

/**
 * A reserva à espera do pagamento: o cronômetro de 10 minutos até `expiresAt` e
 * o botão de pagar, que fecha o pedido.
 */
@Injectable()
export class ReservationStore {
  private readonly api = inject(PurchaseApi);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly now = injectNow();

  private readonly id = signal<string | null>(null);
  /** Uma reserva vira no máximo um pedido: a mesma chave vale para todas as tentativas. */
  private orderKey: string | null = null;
  private readonly expiredByServer = signal(false);

  readonly reservation = httpResource<Reservation>(() => {
    const id = this.id();
    return id ? `${RESERVATIONS_URL}/${id}` : undefined;
  });
  readonly show = httpResource<Show>(() =>
    this.reservation.hasValue() ? `${SHOWS_URL}/${this.reservation.value().showId}` : undefined,
  );

  /** Quanto falta para a reserva expirar. */
  readonly left = computed(() =>
    this.reservation.hasValue()
      ? countdownParts(new Date(this.reservation.value().expiresAt).getTime(), this.now())
      : null,
  );
  /** Fração do prazo que ainda resta, de 0 a 100, para a barra. */
  readonly percentLeft = computed(() => {
    if (!this.reservation.hasValue()) {
      return 0;
    }
    const { createdAt, expiresAt } = this.reservation.value();
    const total = (new Date(expiresAt).getTime() - new Date(createdAt).getTime()) / 1000;
    return total > 0 ? Math.min(100, ((this.left()?.totalSeconds ?? 0) / total) * 100) : 0;
  });
  readonly warning = computed(() => {
    const left = this.left();
    return !!left && !left.done && left.totalSeconds <= RESERVATION_WARNING_SECONDS;
  });
  readonly expired = computed(() => {
    if (!this.reservation.hasValue()) {
      return false;
    }
    const { status } = this.reservation.value();
    return (
      status === 'EXPIRED' ||
      (status === 'HELD' && (this.expiredByServer() || this.left()?.done === true))
    );
  });

  readonly paying = signal(false);
  readonly error = signal<PurchaseError | null>(null);

  load(id: string): void {
    if (this.id() !== id) {
      this.id.set(id);
    }
  }

  /** Fecha o pedido. O pagamento é simulado: o pedido nasce PENDING e a página dele acompanha. */
  pay(): void {
    const id = this.id();
    const status = this.reservation.hasValue() ? this.reservation.value().status : null;
    if (!id || status !== 'HELD' || this.expired() || this.paying()) {
      return;
    }
    this.orderKey ??= uuidv7();
    this.paying.set(true);
    this.error.set(null);
    this.api
      .placeOrder(id, this.orderKey)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (order) => {
          this.paying.set(false);
          void this.router.navigate(['/pedidos', order.id], { replaceUrl: true });
        },
        error: (raw: unknown) => {
          this.paying.set(false);
          const error = toApiError(raw);
          if (error.status === 401) {
            this.auth.login();
            return;
          }
          if (error.code === 'reservation-not-held') {
            // Expirou (ou já foi paga em outra aba): a situação real vem do servidor.
            this.expiredByServer.set(true);
            this.reservation.reload();
            return;
          }
          this.error.set({ message: purchaseErrorMessage(error), traceId: error.traceId });
        },
      });
  }
}
