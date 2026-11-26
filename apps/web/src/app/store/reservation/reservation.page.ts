import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../core/format/money.pipe';
import { toApiError } from '../../core/http/problem';
import { formatClock } from '../shared/countdown';
import { ShowHeading } from '../shared/show-heading';
import { ReservationStore } from './reservation.store';

/**
 * A reserva e o pagamento: resumo, cronômetro de 10 minutos e o botão de
 * pagar. Quando o tempo acaba, a reserva aparece como expirada.
 */
@Component({
  selector: 'app-reservation-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MoneyPipe,
    ShowHeading,
  ],
  providers: [ReservationStore],
  templateUrl: './reservation.page.html',
  styleUrl: './reservation.page.scss',
})
export class ReservationPage {
  protected readonly store = inject(ReservationStore);

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
}
