import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { CountPipe, formatCount } from '../../core/format/count.pipe';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ProducerShowContext } from '../show/show-context';
import { ActivityFeed } from './activity-feed';
import { LiveStatus } from './live-dashboard.client';
import { LiveShowStore } from './live-show.store';
import { SectorCard } from './sector-card';

const STATUS_TEXT: Record<LiveStatus, string> = {
  idle: 'Desconectado',
  connecting: 'Conectando...',
  live: 'Ao vivo',
  reconnecting: 'Reconectando...',
  denied: 'Desconectado',
};

/**
 * Painel ao vivo de um show: números gerais, vendas por setor, entradas na
 * portaria e o feed de atividade, atualizados pelo WebSocket do analytics. O
 * show (artista, local, fuso) vem do catálogo, pela moldura das abas.
 */
@Component({
  selector: 'app-live-show-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CountPipe,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MoneyPipe,
    SectorCard,
    ActivityFeed,
  ],
  providers: [LiveShowStore],
  templateUrl: './live-show.page.html',
  styleUrl: './live-show.page.scss',
})
export class LiveShowPage {
  protected readonly store = inject(LiveShowStore);
  private readonly auth = inject(AuthService);
  private readonly context = inject(ProducerShowContext);

  protected readonly timezone = this.context.timezone;

  protected readonly statusText = computed(() => STATUS_TEXT[this.store.status()]);

  /** Parte dos ingressos vendidos que já entrou, de 0 a 100. */
  protected readonly entryPercent = computed(() => {
    const metrics = this.store.metrics();
    if (!metrics?.checkedIn || metrics.ticketsSold === 0) {
      return 0;
    }
    return Math.min(100, Math.round((metrics.checkedIn / metrics.ticketsSold) * 100));
  });
  protected readonly entryText = computed(() => {
    const metrics = this.store.metrics();
    return metrics
      ? `${formatCount(metrics.checkedIn ?? 0)} de ${formatCount(metrics.ticketsSold)} já entraram (${this.entryPercent()}%)`
      : '';
  });
  protected readonly updatedText = computed(() => {
    const seconds = this.store.secondsSinceUpdate();
    if (seconds === null) {
      return '';
    }
    if (seconds < 2) {
      return 'atualizado agora';
    }
    return seconds < 60
      ? `atualizado há ${seconds} s`
      : `atualizado há ${Math.floor(seconds / 60)} min`;
  });

  constructor() {
    effect(() => {
      const id = this.context.id();
      if (id) {
        this.store.watch(id);
      }
    });
  }

  protected login(): void {
    this.auth.login();
  }
}
