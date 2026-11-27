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
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideCalendarX, lucideInfo } from '@ng-icons/lucide';
import { filter, switchMap } from 'rxjs';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { toApiError } from '../../core/http/problem';
import { Cartaz } from '../../shared/ui/cartaz';
import { ProducerApi } from '../data/producer.api';
import { ShowStatus } from '../shared/show-status';
import { CancelShowData, CancelShowDialog } from './cancel-show.dialog';
import { ProducerShowContext } from './show-context';

/** Estados em que o produtor ainda pode cancelar o show. */
const CANCELLABLE = new Set(['PUBLISHED', 'ON_SALE']);

/**
 * Moldura das telas de um show no painel: o cabeçalho com o cartaz e o show,
 * as abas (Ao vivo, Financeiro, Cupons) e o cancelamento do show. As abas leem
 * o show do `ProducerShowContext`, fornecido aqui.
 */
@Component({
  selector: 'app-show-shell-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Cartaz,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    MatButtonModule,
    MatTabsModule,
    NgIcon,
    ShowDatePipe,
    ShowStatus,
  ],
  viewProviders: [provideIcons({ lucideArrowLeft, lucideCalendarX, lucideInfo })],
  providers: [ProducerShowContext],
  template: `
    <div class="container page">
      <a routerLink="/painel" class="back">
        <ng-icon name="lucideArrowLeft" aria-hidden="true" />
        Meus shows
      </a>

      <header class="head">
        @if (context.value(); as s) {
          <app-cartaz class="poster" size="mini" [artist]="s.artist" />
        } @else {
          <div class="poster skeleton" aria-hidden="true"></div>
        }
        <div class="title">
          @if (context.value(); as s) {
            <app-show-status [status]="s.status" />
            <h1 class="display">{{ s.artist }}</h1>
            <p class="meta">
              {{ s.title }} · {{ s.startsAt | showDate: context.timezone() : 'date' }} às
              {{ s.startsAt | showDate: context.timezone() : 'time' }}
              @if (s.venue; as venue) {
                · {{ venue.name }}, {{ venue.city }}/{{ venue.state }}
              }
            </p>
          } @else {
            <h1 class="display">{{ context.show.isLoading() ? 'Carregando...' : 'Show' }}</h1>
          }
        </div>
        @if (canCancel()) {
          <button
            matButton="outlined"
            type="button"
            class="danger"
            [disabled]="cancelling()"
            (click)="cancelShow()"
          >
            <ng-icon name="lucideCalendarX" aria-hidden="true" />
            Cancelar show
          </button>
        }
      </header>

      @if (context.value()?.status === 'CANCELLED') {
        <p class="banner" role="status">
          <ng-icon name="lucideInfo" aria-hidden="true" />
          Show cancelado. Os pedidos confirmados são reembolsados automaticamente; acompanhe no
          Financeiro.
        </p>
      }

      <nav
        mat-tab-nav-bar
        mat-stretch-tabs="false"
        mat-align-tabs="start"
        [tabPanel]="panel"
        [disableRipple]="true"
        aria-label="Telas do show"
      >
        @for (tab of tabs; track tab.path) {
          <a
            mat-tab-link
            [routerLink]="tab.path"
            routerLinkActive
            #active="routerLinkActive"
            [routerLinkActiveOptions]="{ exact: true }"
            [active]="active.isActive"
          >
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
      gap: 20px;
      padding-block: 20px 64px;
    }
    .back {
      justify-self: start;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 44px;
      color: var(--lt-muted);
      font-size: 0.875rem;
      font-weight: 600;
      text-decoration: none;
    }
    .back:hover {
      color: var(--lt-text);
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 16px 20px;
    }
    .poster {
      flex: none;
      width: 96px;
      height: 120px;
      transform: rotate(-2deg);
    }
    .title {
      display: flex;
      flex: 1 1 320px;
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
      min-width: 0;
    }
    h1 {
      margin: 0;
      font-size: clamp(2.5rem, 6vw, 3.5rem);
      overflow-wrap: anywhere;
    }
    .meta {
      margin: 0;
      color: var(--lt-muted);
    }
    .danger {
      --mat-button-outlined-label-text-color: var(--lt-danger);
      --mat-button-outlined-outline-color: #f2c4c4;
      --mat-button-outlined-container-height: 44px;
      background: var(--lt-surface);
    }
    .banner {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0;
      padding: 14px 16px;
      border: 1px solid #f2c4c4;
      border-radius: var(--lt-radius);
      background: var(--lt-danger-soft);
      color: #7a1414;
      font-weight: 500;
    }
    .banner ng-icon {
      font-size: 20px;
    }
    nav {
      --mat-tab-divider-color: var(--lt-line-strong);
      --mat-tab-container-height: 48px;
      --mat-tab-label-text-size: 1rem;
      background: transparent;
    }
    mat-tab-nav-panel {
      display: block;
      padding-top: 8px;
    }
    @media (max-width: 600px) {
      .poster {
        width: 72px;
        height: 90px;
      }
      .title {
        flex-basis: calc(100% - 92px);
      }
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
    { path: './', label: 'Ao vivo' },
    { path: 'financeiro', label: 'Financeiro' },
    { path: 'cupons', label: 'Cupons' },
  ];

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
