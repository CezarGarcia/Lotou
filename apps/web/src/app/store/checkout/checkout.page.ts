import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../core/format/money.pipe';
import { cpfValidator } from '../../core/forms/cpf';
import { CpfMask } from '../../core/forms/cpf-mask';
import { toApiError } from '../../core/http/problem';
import { formatClock } from '../shared/countdown';
import { SaleChip } from '../shared/sale-chip';
import { ShowHeading } from '../shared/show-heading';
import { KIND_LABELS } from '../show/buy-panel';
import { CheckoutStore } from './checkout.store';
import { MAX_SEATS } from './seat-map.state';
import { SeatMap } from './seat-map';

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
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MoneyPipe,
    CpfMask,
    SaleChip,
    ShowHeading,
    SeatMap,
  ],
  providers: [CheckoutStore],
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
      return;
    }
    this.store.reserve(this.cpf.value);
  }
}
