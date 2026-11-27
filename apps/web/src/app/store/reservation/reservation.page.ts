import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
  Injector,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCloudOff,
  lucideCreditCard,
  lucideLoaderCircle,
  lucideLock,
  lucideSearchX,
  lucideTicketPercent,
  lucideTimerOff,
} from '@ng-icons/lucide';
import { MoneyPipe, formatCents } from '../../core/format/money.pipe';
import { toApiError } from '../../core/http/problem';
import { formatClock } from '../shared/countdown';
import { ShowHeading } from '../shared/show-heading';
import { PayBar } from '../checkout/pay-bar';
import { PurchaseSteps } from '../checkout/purchase-steps';
import { TicketCard } from '../checkout/ticket-card';
import { ReservationStore } from './reservation.store';
import { ReservationItems } from './reservation-items';
import { ReservationTimer } from './reservation-timer';
import { BackLink } from '../checkout/back-link';

/**
 * A reserva e o pagamento: resumo, cronômetro de 10 minutos, o total com o
 * cupom e a taxa de serviço, e o botão de pagar. Quando o tempo acaba, a
 * reserva aparece como expirada.
 */
@Component({
  selector: 'app-reservation-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    NgIcon,
    MatFormFieldModule,
    MatInputModule,
    MoneyPipe,
    ShowHeading,
    PurchaseSteps,
    PayBar,
    BackLink,
    TicketCard,
    ReservationTimer,
    ReservationItems,
  ],
  providers: [ReservationStore],
  viewProviders: [
    provideIcons({
      lucideCircleCheck,
      lucideCloudOff,
      lucideCreditCard,
      lucideLoaderCircle,
      lucideLock,
      lucideSearchX,
      lucideTicketPercent,
      lucideTimerOff,
    }),
  ],
  templateUrl: './reservation.page.html',
  styleUrl: './reservation.page.scss',
})
export class ReservationPage {
  protected readonly store = inject(ReservationStore);
  private readonly injector = inject(Injector);

  protected readonly couponOpen = signal(false);
  protected readonly couponCode = new FormControl('', { nonNullable: true });
  protected readonly couponForm = new FormGroup({ code: this.couponCode });
  private readonly couponInput = viewChild<ElementRef<HTMLInputElement>>('couponInput');

  /** Anúncio para leitores de tela quando o cupom muda o total. */
  protected readonly couponAnnouncement = computed(() => {
    const quote = this.store.quote();
    if (!quote?.coupon) {
      return '';
    }
    return `Cupom ${quote.coupon.code} aplicado: desconto de ${formatCents(quote.discountCents)}. Novo total: ${formatCents(quote.totalCents)}.`;
  });

  /** Parâmetro `:id` da rota. */
  readonly id = input.required<string>();

  protected readonly clock = computed(() => {
    const left = this.store.left();
    return left ? formatClock(left) : '';
  });

  /** Para leitores de tela: muda uma vez por minuto, não a cada segundo. */
  protected readonly minutesLeft = computed(() => {
    const left = this.store.left();
    if (!left || left.done) {
      return '';
    }
    const minutes = Math.ceil(left.totalSeconds / 60);
    return minutes === 1
      ? 'Falta menos de 1 minuto para a reserva expirar.'
      : `Faltam ${minutes} minutos para a reserva expirar.`;
  });

  /** A reserva ainda espera o pagamento: a barra de pagar aparece no celular. */
  protected readonly held = computed(
    () =>
      this.store.reservation.hasValue() &&
      this.store.reservation.value().status === 'HELD' &&
      !this.store.expired(),
  );

  protected readonly seated = computed(
    () =>
      this.store.reservation.hasValue() &&
      this.store.reservation.value().items.some((item) => item.seat !== null),
  );

  protected readonly notFound = computed(() => {
    const error = this.store.reservation.error();
    return error instanceof HttpErrorResponse && [400, 403, 404].includes(error.status);
  });
  protected readonly loadError = computed(() => {
    const error = this.store.reservation.error();
    return error ? toApiError(error) : undefined;
  });

  constructor() {
    effect(() => this.store.load(this.id()));
  }

  protected openCoupon(): void {
    this.couponOpen.set(true);
    afterNextRender(() => this.couponInput()?.nativeElement.focus(), { injector: this.injector });
  }

  protected applyCoupon(): void {
    this.store.applyCoupon(this.couponCode.value);
  }
}
