import { httpResource } from '@angular/common/http';
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { Subject, catchError, map, of, switchMap } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { AttemptKey } from '../../core/http/idempotency';
import { ApiError, isTransient, toApiError } from '../../core/http/problem';
import { PurchaseApi, RESERVATIONS_URL } from '../data/purchase.api';
import { OrderQuote, Reservation } from '../data/sale.models';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { countdownParts, injectNow } from '../shared/countdown';
import {
  PurchaseError,
  couponInvalidMessage,
  purchaseErrorMessage,
} from '../shared/purchase-errors';

/** Abaixo disso, o cronômetro fica em destaque. */
export const RESERVATION_WARNING_SECONDS = 120;

/** Um pedido de orçamento: sem cupom (o total da reserva) ou com o cupom digitado. */
interface QuoteRequest {
  reservationId: string;
  couponCode: string | null;
}

type QuoteOutcome =
  { request: QuoteRequest; quote: OrderQuote } | { request: QuoteRequest; error: ApiError };

/** Código do cupom como o servidor guarda: sem espaços e em maiúsculas. */
export const normalizeCouponCode = (code: string) => code.replace(/\s+/g, '').toUpperCase();

/**
 * A reserva à espera do pagamento: o cronômetro de 10 minutos até `expiresAt`,
 * o orçamento (ingressos, desconto do cupom, taxa de serviço e total) e o
 * botão de pagar, que fecha o pedido com o cupom aplicado.
 *
 * O valor que aparece é sempre o do servidor (`POST /orders/quote`): a loja
 * não recalcula taxa nem desconto, só mostra.
 */
@Injectable()
export class ReservationStore {
  private readonly api = inject(PurchaseApi);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly now = injectNow();

  private readonly id = signal<string | null>(null);
  /**
   * Chave de idempotência do pedido: a mesma em todas as tentativas com o
   * mesmo corpo (um clique duplo ou uma falha de rede não criam dois pedidos);
   * trocar o cupom ou receber uma recusa definitiva começa uma tentativa nova.
   */
  private readonly orderKey = new AttemptKey();
  private readonly expiredByServer = signal(false);
  private readonly quoteRequests = new Subject<QuoteRequest>();

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

  /** O orçamento mais recente aceito pelo servidor; `null` enquanto o primeiro não chega. */
  readonly quote = signal<OrderQuote | null>(null);
  /** Falha ao calcular o total sem cupom: sem ele, o pagamento não é oferecido. */
  readonly quoteError = signal<PurchaseError | null>(null);
  /** Um cupom está sendo conferido. */
  readonly checkingCoupon = signal(false);
  /** Por que o último cupom digitado não foi aceito. */
  readonly couponError = signal<string | null>(null);
  /** O cupom aplicado, que vai no pedido. */
  readonly coupon = computed(() => this.quote()?.coupon ?? null);
  /** Só paga com o total na tela, e nunca no meio da conferência de um cupom. */
  readonly canPay = computed(
    () => this.quote() !== null && !this.checkingCoupon() && !this.paying() && !this.expired(),
  );

  /** A reserva que ainda espera pagamento: é dela que sai o orçamento. */
  private readonly heldId = computed(() =>
    this.reservation.hasValue() && this.reservation.value().status === 'HELD'
      ? this.reservation.value().id
      : null,
  );

  constructor() {
    this.quoteRequests
      .pipe(
        // Um pedido novo cancela o anterior: um cupom digitado por último sempre vence.
        switchMap((request) =>
          this.api.quote(request.reservationId, request.couponCode).pipe(
            map((quote): QuoteOutcome => ({ request, quote })),
            catchError((raw: unknown) => of<QuoteOutcome>({ request, error: toApiError(raw) })),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((outcome) => this.applyQuote(outcome));

    effect(() => {
      const id = this.heldId();
      if (id) {
        untracked(() => this.requestQuote({ reservationId: id, couponCode: null }));
      }
    });
  }

  /** Confere o cupom e, se for aceito, mostra o total com o desconto. */
  applyCoupon(raw: string): void {
    const id = this.heldId();
    const couponCode = normalizeCouponCode(raw);
    if (!id || couponCode === '') {
      this.couponError.set(couponCode === '' ? 'Digite o código do cupom.' : null);
      return;
    }
    this.requestQuote({ reservationId: id, couponCode });
  }

  /** Tira o cupom: volta ao total sem desconto. */
  removeCoupon(): void {
    const id = this.heldId();
    this.couponError.set(null);
    if (id) {
      this.requestQuote({ reservationId: id, couponCode: null });
    }
  }

  /** Tenta de novo o orçamento sem cupom, depois de uma falha. */
  retryQuote(): void {
    this.removeCoupon();
  }

  private requestQuote(request: QuoteRequest): void {
    this.checkingCoupon.set(request.couponCode !== null);
    if (request.couponCode === null) {
      this.quoteError.set(null);
    }
    this.quoteRequests.next(request);
  }

  private applyQuote(outcome: QuoteOutcome): void {
    const { request } = outcome;
    this.checkingCoupon.set(false);
    if ('quote' in outcome) {
      this.quote.set(outcome.quote);
      this.quoteError.set(null);
      if (request.couponCode !== null) {
        this.couponError.set(null);
      }
      return;
    }
    const { error } = outcome;
    if (error.status === 401) {
      this.auth.login();
      return;
    }
    if (error.code === 'reservation-not-held') {
      this.expiredByServer.set(true);
      this.reservation.reload();
      return;
    }
    if (request.couponCode !== null) {
      // O cupom não vale: o orçamento anterior continua na tela.
      this.couponError.set(
        error.code === 'coupon-invalid'
          ? couponInvalidMessage(error.details?.['reason'])
          : purchaseErrorMessage(error),
      );
      return;
    }
    this.quoteError.set({ message: purchaseErrorMessage(error), traceId: error.traceId });
  }

  load(id: string): void {
    if (this.id() !== id) {
      this.id.set(id);
    }
  }

  /** Fecha o pedido. O pagamento é simulado: o pedido nasce PENDING e a página dele acompanha. */
  pay(): void {
    const id = this.heldId();
    if (!id || !this.canPay()) {
      return;
    }
    const couponCode = this.coupon()?.code ?? null;
    const key = this.orderKey.for({ reservationId: id, couponCode });
    this.paying.set(true);
    this.error.set(null);
    this.api
      .placeOrder(id, key, couponCode)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (order) => {
          this.paying.set(false);
          void this.router.navigate(['/pedidos', order.id], { replaceUrl: true });
        },
        error: (raw: unknown) => {
          this.paying.set(false);
          const error = toApiError(raw);
          if (!isTransient(error)) {
            this.orderKey.reset();
          }
          if (error.status === 401) {
            this.auth.login();
            return;
          }
          if (error.code === 'coupon-invalid') {
            // O cupom acabou (ou foi pausado) entre o orçamento e o pedido: sai do
            // pedido, o total volta ao valor sem desconto e o comprador decide.
            const message = couponInvalidMessage(error.details?.['reason']);
            this.couponError.set(message);
            this.quote.set(null);
            this.requestQuote({ reservationId: id, couponCode: null });
            this.error.set({
              message: `${message} Tiramos o cupom do pedido: confira o novo total antes de pagar.`,
            });
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
