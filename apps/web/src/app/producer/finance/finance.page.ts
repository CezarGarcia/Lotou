import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { RefundFailedOrder } from '../data/finance.api';
import { ProducerShowContext } from '../show/show-context';
import { FinanceStore } from './finance.store';

/**
 * O financeiro de um show: o relatório com cada linha explicada, o PDF por
 * e-mail e os reembolsos que travaram, para mandar de novo.
 */
@Component({
  selector: 'app-finance-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule, MoneyPipe, ShowDatePipe],
  providers: [FinanceStore],
  templateUrl: './finance.page.html',
  styleUrl: './finance.page.scss',
})
export class FinancePage {
  protected readonly store = inject(FinanceStore);
  protected readonly context = inject(ProducerShowContext);
  private readonly snackBar = inject(MatSnackBar);

  constructor() {
    effect(() => {
      const id = this.context.id();
      if (id) {
        this.store.load(id);
      }
    });
  }

  /** Os 8 primeiros caracteres do ID: o bastante para achar o pedido no suporte. */
  protected shortId(id: string): string {
    return id.slice(0, 8);
  }

  protected requestPdf(): void {
    this.store.requestPdf().subscribe((error) => {
      this.snackBar.open(
        error
          ? `Não foi possível pedir o PDF. ${error.message}`
          : 'Pedido recebido. O PDF do relatório chega no seu e-mail em alguns minutos.',
        'OK',
        { duration: 8_000 },
      );
    });
  }

  protected retry(order: RefundFailedOrder): void {
    this.store.retryRefund(order).subscribe((ok) => {
      if (ok) {
        this.snackBar.open(`Reembolso do pedido ${this.shortId(order.id)} enviado de novo.`, 'OK', {
          duration: 6_000,
        });
      }
    });
  }
}
