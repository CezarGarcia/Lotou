import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Router, RouterLink } from '@angular/router';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { formatWait } from '../shared/countdown';
import { ShowHeading } from '../shared/show-heading';
import { SalesCountdown } from '../show/sales-countdown';
import { QueueStore } from './queue.store';

/**
 * Fila virtual de um show de alta demanda. Entra na fila ao abrir, mostra a
 * posição e o tempo estimado ao vivo (SSE) e, quando chega a vez, leva ao
 * checkout do setor escolhido.
 */
@Component({
  selector: 'app-queue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    ShowDatePipe,
    ShowHeading,
    SalesCountdown,
  ],
  providers: [QueueStore],
  templateUrl: './queue.page.html',
  styleUrl: './queue.page.scss',
})
export class QueuePage {
  private readonly router = inject(Router);
  protected readonly store = inject(QueueStore);

  /** Parâmetro `:id` da rota. */
  readonly id = input.required<string>();
  /** Setor escolhido na página do show (`?setor=`). */
  readonly setor = input<string>();

  protected readonly show = httpResource<Show>(() => `${SHOWS_URL}/${this.id()}`);
  protected readonly tz = computed(() =>
    this.show.hasValue() ? this.show.value().venue?.timezone : undefined,
  );

  /** Anúncio para leitores de tela: só quando a situação muda, não a cada posição. */
  protected readonly announcement = computed(() => {
    switch (this.store.status()?.status) {
      case 'NOT_OPEN':
        return 'A sala de espera ainda não abriu.';
      case 'WAITING_ROOM':
        return 'Você está na sala de espera.';
      case 'QUEUED':
        return 'Você está na fila.';
      case 'ADMITTED':
        return 'Chegou a sua vez. Abrindo a compra.';
      case 'NOT_IN_QUEUE':
        return 'Você não está mais na fila.';
      case 'CLOSED':
        return 'As vendas foram encerradas.';
      default:
        return '';
    }
  });

  protected readonly formatWait = formatWait;

  constructor() {
    effect(() => this.store.start(this.id()));

    // A vez chegou: vai ao checkout sem deixar a fila no histórico.
    effect(() => {
      if (!this.store.canBuy()) {
        return;
      }
      const sector = this.setor();
      void (sector
        ? this.router.navigate(['/shows', this.id(), 'comprar', sector], { replaceUrl: true })
        : this.router.navigate(['/shows', this.id()], { replaceUrl: true }));
    });
  }

  protected number(value: number): string {
    return value.toLocaleString('pt-BR');
  }

  /** Quantas pessoas estão na frente: a posição 1 é a próxima. */
  protected ahead(position: number): string {
    const people = position - 1;
    return people === 0
      ? 'Você é o próximo.'
      : `${people.toLocaleString('pt-BR')} ${people === 1 ? 'pessoa' : 'pessoas'} na sua frente.`;
  }
}
