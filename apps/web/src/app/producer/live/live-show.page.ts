import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { CountPipe } from '../../core/format/count.pipe';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Show } from '../../store/data/show.models';
import { SHOWS_URL } from '../../store/data/shows.api';
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
 * Painel ao vivo de um show: números gerais, vendas por setor e o feed de
 * atividade, atualizados pelo WebSocket do analytics. Os dados do show
 * (artista, local, fuso) vêm do catálogo.
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
    ShowDatePipe,
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

  /** Parâmetro `:id` da rota. */
  readonly id = input.required<string>();

  protected readonly show = httpResource<Show>(() => `${SHOWS_URL}/${this.id()}`);
  protected readonly timezone = computed(() =>
    this.show.hasValue() ? this.show.value().venue?.timezone : undefined,
  );

  protected readonly statusText = computed(() => STATUS_TEXT[this.store.status()]);
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
    effect(() => this.store.watch(this.id()));
  }

  protected login(): void {
    this.auth.login();
  }
}
