import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, switchMap } from 'rxjs';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { toApiError } from '../../core/http/problem';
import { ProducerApi } from '../data/producer.api';
import { SHOW_STATUS_LABELS, label } from '../shared/labels';
import { CancelShowData, CancelShowDialog } from './cancel-show.dialog';
import { ProducerShowContext } from './show-context';

/** Estados em que o produtor ainda pode cancelar o show. */
const CANCELLABLE = new Set(['PUBLISHED', 'ON_SALE']);

/**
 * Moldura das telas de um show no painel: o cabeçalho com o show, as abas
 * (Ao vivo, Financeiro, Cupons) e o cancelamento do show. As abas leem o show
 * do `ProducerShowContext`, fornecido aqui.
 */
@Component({
  selector: 'app-show-shell-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    MatButtonModule,
    MatIconModule,
    MatTabsModule,
    ShowDatePipe,
  ],
  providers: [ProducerShowContext],
  template: `
    <div class="container page">
      <a matButton routerLink="/painel" class="back">
        <mat-icon aria-hidden="true">arrow_back</mat-icon>
        Meus shows
      </a>

      <header class="head">
        <div class="title">
          <p class="eyebrow">Painel do produtor</p>
          @if (context.value(); as s) {
            <h1>{{ s.artist }}</h1>
            <p class="meta">
              {{ s.title }} · {{ s.startsAt | showDate: context.timezone() : 'date' }} às
              {{ s.startsAt | showDate: context.timezone() : 'time' }}
              @if (s.venue; as venue) {
                · {{ venue.name }}, {{ venue.city }}/{{ venue.state }}
              }
            </p>
          } @else {
            <h1>{{ context.show.isLoading() ? 'Carregando...' : 'Show' }}</h1>
          }
        </div>
        <div class="actions">
          @if (context.value(); as s) {
            <span class="status" [attr.data-status]="s.status">{{ status(s.status) }}</span>
          }
          @if (canCancel()) {
            <button
              matButton="outlined"
              type="button"
              class="danger"
              [disabled]="cancelling()"
              (click)="cancelShow()"
            >
              <mat-icon aria-hidden="true">event_busy</mat-icon>
              Cancelar show
            </button>
          }
        </div>
      </header>

      @if (context.value()?.status === 'CANCELLED') {
        <p class="banner" role="status">
          <mat-icon aria-hidden="true">info</mat-icon>
          Show cancelado. Os pedidos confirmados são reembolsados automaticamente; acompanhe no
          Financeiro.
        </p>
      }

      <nav mat-tab-nav-bar [tabPanel]="panel" aria-label="Telas do show">
        @for (tab of tabs; track tab.path) {
          <a
            mat-tab-link
            [routerLink]="tab.path"
            routerLinkActive
            #active="routerLinkActive"
            [routerLinkActiveOptions]="{ exact: true }"
            [active]="active.isActive"
          >
            <mat-icon aria-hidden="true">{{ tab.icon }}</mat-icon>
            {{ tab.label }}
          </a>
        }
      </nav>
      <mat-tab-nav-panel #panel>
        <router-outlet />
      </mat-tab-nav-panel>
    </div>
  `,
  styles: `
    .page {
      display: grid;
      gap: 16px;
      padding-block: 16px 64px;
    }
    .back {
      justify-self: start;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 12px 24px;
    }
    .title {
      min-width: 0;
    }
    .eyebrow {
      margin: 0;
      font: var(--mat-sys-label-large);
      font-weight: 600;
      color: var(--mat-sys-primary);
    }
    h1 {
      margin: 4px 0;
      font-size: clamp(1.6rem, 4vw, 2.2rem);
      line-height: 1.15;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .meta {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
    }
    .status {
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--mat-sys-surface-container-highest);
      font: var(--mat-sys-label-medium);
      font-weight: 600;
    }
    .status[data-status='ON_SALE'] {
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    .status[data-status='CANCELLED'] {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .danger {
      --mat-button-outlined-label-text-color: var(--mat-sys-error);
    }
    .banner {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 12px 16px;
      border-radius: 12px;
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    nav mat-icon {
      margin-right: 6px;
    }
    mat-tab-nav-panel {
      display: block;
      padding-top: 8px;
    }
  `,
})
export class ShowShellPage {
  protected readonly context = inject(ProducerShowContext);
  private readonly api = inject(ProducerApi);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);

  /** Parâmetro `:id` da rota. */
  readonly id = input.required<string>();

  protected readonly tabs = [
    { path: './', label: 'Ao vivo', icon: 'monitoring' },
    { path: 'financeiro', label: 'Financeiro', icon: 'account_balance' },
    { path: 'cupons', label: 'Cupons', icon: 'sell' },
  ];

  protected readonly status = (value: string) => label(SHOW_STATUS_LABELS, value);
  protected readonly cancelling = signal(false);
  protected readonly canCancel = computed(() => {
    const show = this.context.value();
    return !!show && CANCELLABLE.has(show.status);
  });

  constructor() {
    effect(() => this.context.id.set(this.id()));
  }

  /** Pede a confirmação forte e cancela o show. */
  protected cancelShow(): void {
    const show = this.context.value();
    if (!show || this.cancelling()) {
      return;
    }
    this.dialog
      .open<CancelShowDialog, CancelShowData, boolean>(CancelShowDialog, {
        data: { title: show.title, artist: show.artist },
        maxWidth: '560px',
        ariaModal: true,
      })
      .afterClosed()
      .pipe(
        filter((confirmed) => confirmed === true),
        switchMap(() => {
          this.cancelling.set(true);
          return this.api.cancelShow(show.id);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.cancelling.set(false);
          this.snackBar.open(
            'Show cancelado. Os reembolsos dos pedidos confirmados já começaram.',
            'OK',
            { duration: 8_000 },
          );
          this.context.show.reload();
        },
        error: (raw: unknown) => {
          this.cancelling.set(false);
          const error = toApiError(raw);
          this.snackBar.open(
            error.status === 409
              ? 'O show não pode mais ser cancelado: as vendas já foram encerradas ou ele já aconteceu.'
              : `Não foi possível cancelar o show. ${error.message}`,
            'OK',
            { duration: 10_000 },
          );
          this.context.show.reload();
        },
      });
  }
}
