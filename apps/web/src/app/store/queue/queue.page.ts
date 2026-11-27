import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideBan,
  lucideClock,
  lucideCloudOff,
  lucideHourglass,
  lucideLoaderCircle,
  lucidePartyPopper,
  lucideTimerOff,
  lucideTriangleAlert,
  lucideUsers,
} from '@ng-icons/lucide';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { formatWait } from '../shared/countdown';
import { ShowHeading } from '../shared/show-heading';
import { SalesCountdown } from '../show/sales-countdown';
import { QueueRules } from './queue-rules';
import { QueueStore } from './queue.store';
import { BackLink } from '../checkout/back-link';

/**
 * Fila virtual de um show de alta demanda. Entra na fila ao abrir, mostra a
 * posição e o tempo estimado ao vivo (SSE) e, quando chega a vez, leva ao
 * checkout do setor escolhido.
 */
@Component({
  selector: 'app-queue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, BackLink, NgIcon, ShowDatePipe, ShowHeading, SalesCountdown, QueueRules],
  providers: [QueueStore],
  viewProviders: [
    provideIcons({
      lucideArrowRight,
      lucideBan,
      lucideClock,
      lucideCloudOff,
      lucideHourglass,
      lucideLoaderCircle,
      lucidePartyPopper,
      lucideTimerOff,
      lucideTriangleAlert,
      lucideUsers,
    }),
  ],
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

  /** A situação na fila, para o visual do cartão (a admissão chama atenção). */
  protected readonly state = computed(() =>
    this.store.error() ? 'ERROR' : (this.store.status()?.status ?? 'LOADING'),
  );

  /** A maior posição vista nesta tela: é dela que a barra de avanço parte. */
  private readonly firstPosition = linkedSignal<number | undefined, number>({
    source: () => this.store.status()?.position,
    computation: (position, previous) => Math.max(previous?.value ?? 0, position ?? 0),
  });

  /** Quanto da fila já andou desde que você entrou, de 0 a 100. */
  protected readonly progress = computed(() => {
    const position = this.store.status()?.position;
    const first = this.firstPosition();
    if (!position || first <= 1) {
      return position === 1 ? 100 : 0;
    }
    return Math.round(((first - position) / (first - 1)) * 100);
  });

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
