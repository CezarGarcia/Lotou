import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleAlert,
  lucideCloudOff,
  lucideInfo,
  lucideLoaderCircle,
  lucideSearchX,
  lucideTimer,
  lucideTimerOff,
  lucideUserCheck,
} from '@ng-icons/lucide';
import { MoneyPipe } from '../../core/format/money.pipe';
import { cpfValidator } from '../../core/forms/cpf';
import { CpfMask } from '../../core/forms/cpf-mask';
import { toApiError } from '../../core/http/problem';
import { formatClock } from '../shared/countdown';
import { SaleChip } from '../shared/sale-chip';
import { ShowHeading } from '../shared/show-heading';
import { KIND_LABELS } from '../show/buy-panel';
import { CheckoutStore } from './checkout.store';
import { PurchaseSteps } from './purchase-steps';
import { MAX_SEATS } from './seat-map.state';
import { SeatMap } from './seat-map';
import { PayBar } from './pay-bar';
import { TicketCard } from './ticket-card';
import { BackLink } from './back-link';
import { QuantityStepper } from './quantity-stepper';

/**
 * Checkout de um setor: quantidade (pista) ou cadeiras no mapa (lugar
 * marcado), o CPF e a reserva. A reserva segura os ingressos por 10 minutos.
 */
@Component({
  selector: 'app-checkout-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    NgIcon,
    MatFormFieldModule,
    MatInputModule,
    MoneyPipe,
    CpfMask,
    SaleChip,
    ShowHeading,
    SeatMap,
    PurchaseSteps,
    PayBar,
    BackLink,
    QuantityStepper,
    TicketCard,
  ],
  providers: [CheckoutStore],
  viewProviders: [
    provideIcons({
      lucideCircleAlert,
      lucideCloudOff,
      lucideInfo,
      lucideLoaderCircle,
      lucideSearchX,
      lucideTimer,
      lucideTimerOff,
      lucideUserCheck,
    }),
  ],
  templateUrl: './checkout.page.html',
  styleUrl: './checkout.page.scss',
})
export class CheckoutPage {
  private readonly title = inject(Title);
  protected readonly store = inject(CheckoutStore);

  /** Parâmetros `:id` e `:sectorId` da rota. */
  readonly id = input.required<string>();
  readonly sectorId = input.required<string>();

  protected readonly cpf = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, cpfValidator],
  });
  protected readonly form = new FormGroup({ cpf: this.cpf });
  private readonly cpfInput = viewChild<ElementRef<HTMLInputElement>>('cpfInput');

  protected readonly notFound = computed(() => {
    const error = this.store.show.error();
    return error instanceof HttpErrorResponse && [400, 404].includes(error.status);
  });
  protected readonly showError = computed(() => {
    const error = this.store.show.error();
    return error ? toApiError(error) : undefined;
  });

  protected readonly admissionClock = computed(() => {
    const left = this.store.admissionLeft();
    return left ? formatClock(left) : '';
  });

  protected readonly kindLabels = KIND_LABELS;
  protected readonly maxSeats = MAX_SEATS;

  constructor() {
    effect(() => this.store.load(this.id(), this.sectorId()));
    effect(() => {
      const sector = this.store.sector();
      if (sector && this.store.show.hasValue()) {
        this.title.setTitle(`${sector.name}: ${this.store.show.value().artist} | Lotou.`);
      }
    });
  }

  protected submit(): void {
    if (this.cpf.invalid) {
      this.cpf.markAsTouched();
      // No celular, o botão fica na barra de baixo, longe do campo: leva o foco até ele.
      this.cpfInput()?.nativeElement.focus();
      return;
    }
    this.store.reserve(this.cpf.value);
  }
}
