import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { ShowCover } from '../shared/show-cover';
import { MyOrdersStore } from './my-orders.store';
import { ORDER_STATUS_LABELS } from './order.store';

/** "Meus ingressos": os pedidos do comprador, cada um com link para o detalhe. */
@Component({
  selector: 'app-my-tickets-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MoneyPipe,
    ShowDatePipe,
    ShowCover,
  ],
  providers: [MyOrdersStore],
  template: `
    <div class="container page">
      <h1>Meus ingressos</h1>

      <section aria-live="polite" [attr.aria-busy]="store.loading()">
        @if (store.loading()) {
          <div class="list" aria-hidden="true">
            @for (item of skeletons; track $index) {
              <div class="skeleton"></div>
            }
          </div>
        } @else if (store.error() && store.orders().length === 0) {
          @let error = store.error()!;
          <div class="state" role="alert">
            <mat-icon aria-hidden="true">cloud_off</mat-icon>
            <h2>Não foi possível carregar seus pedidos</h2>
            <p>{{ error.message }}</p>
            <button matButton="tonal" type="button" (click)="store.retry()">Tentar de novo</button>
          </div>
        } @else if (store.empty()) {
          <div class="state">
            <mat-icon aria-hidden="true">confirmation_number</mat-icon>
            <h2>Você ainda não comprou ingressos</h2>
            <p>Os pedidos aparecem aqui assim que você reserva e paga.</p>
            <a matButton="filled" routerLink="/">Ver os shows</a>
          </div>
        } @else {
          <ul class="list">
            @for (order of store.orders(); track order.id) {
              @let show = store.shows().get(order.showId);
              <li>
                <a class="order" [routerLink]="['/pedidos', order.id]">
                  <div class="cover" aria-hidden="true">
                    <app-show-cover [artist]="show?.artist ?? 'Lotou'" />
                  </div>
                  <div class="text">
                    <strong>{{ show?.artist ?? 'Show' }}</strong>
                    @if (show) {
                      <span>
                        {{ show.startsAt | showDate: show.venue?.timezone : 'date' }}
                        @if (show.venue; as venue) {
                          · {{ venue.city }}/{{ venue.state }}
                        }
                      </span>
                    }
                    <span>
                      {{ order.tickets === 1 ? '1 ingresso' : order.tickets + ' ingressos' }}
                      · {{ order.totalCents | brl }}
                    </span>
                  </div>
                  <span class="status" [attr.data-status]="order.status">
                    {{ statusLabels[order.status] }}
                  </span>
                </a>
              </li>
            }
          </ul>

          @if (store.error(); as error) {
            <p class="inline-error" role="alert">{{ error.message }}</p>
          }
          @if (store.hasMore()) {
            <div class="more">
              @if (store.loadingMore()) {
                <mat-progress-bar mode="indeterminate" aria-label="Carregando mais pedidos" />
              } @else {
                <button matButton="outlined" type="button" (click)="store.loadMore()">
                  Carregar mais
                </button>
              }
            </div>
          }
        }
      </section>
    </div>
  `,
  styleUrl: './my-tickets.page.scss',
})
export class MyTicketsPage {
  protected readonly store = inject(MyOrdersStore);
  protected readonly statusLabels = ORDER_STATUS_LABELS;
  protected readonly skeletons = Array.from({ length: 3 });
}
