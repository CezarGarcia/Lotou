import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCloudOff,
  lucideInfo,
  lucideMail,
  lucideRotateCcw,
} from '@ng-icons/lucide';
import { MoneyPipe, formatCents } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { RefundFailedOrder, Statement } from '../data/finance.api';
import { ProducerShowContext } from '../show/show-context';
import { FinanceStore } from './finance.store';

/** Um pedaço da barra das vendas brutas: o que fica e o que sai. */
export interface CompositionSegment {
  key: keyof Statement;
  name: string;
  cents: number;
  /** Parte das vendas brutas, de 0 a 100. */
  percent: number;
  /** A parte em texto, com vírgula: "71,3%". */
  percentText: string;
}

const PERCENT = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/**
 * Para onde vão as vendas brutas: o valor a receber e cada desconto. Sem
 * vendas, não há barra. As partes vazias ficam de fora.
 */
export function composition(
  statement: Statement,
): { segments: CompositionSegment[]; label: string } | null {
  const gross = statement.grossSalesCents;
  if (gross <= 0) {
    return null;
  }
  const parts: Omit<CompositionSegment, 'percent' | 'percentText'>[] = [
    { key: 'receivableCents', name: 'A receber', cents: statement.receivableCents },
    { key: 'discountsCents', name: 'Descontos', cents: statement.discountsCents },
    { key: 'refundsCents', name: 'Reembolsos', cents: statement.refundsCents },
    { key: 'platformFeeCents', name: 'Taxa', cents: statement.platformFeeCents },
  ];
  const segments = parts
    .filter((part) => part.cents > 0)
    .map((part) => {
      const percent = Math.round((part.cents / gross) * 1000) / 10;
      return { ...part, percent, percentText: `${PERCENT.format(percent)}%` };
    });
  const label =
    'Das vendas brutas: ' +
    segments.map((part) => `${part.name.toLowerCase()} ${formatCents(part.cents)}`).join(', ');
  return { segments, label };
}

/**
 * O financeiro de um show: o relatório com cada linha explicada, o PDF por
 * e-mail e os reembolsos que travaram, para mandar de novo.
 */
@Component({
  selector: 'app-finance-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatProgressSpinnerModule, MoneyPipe, NgIcon, ShowDatePipe],
  viewProviders: [
    provideIcons({ lucideCircleCheck, lucideCloudOff, lucideInfo, lucideMail, lucideRotateCcw }),
  ],
  providers: [FinanceStore],
  templateUrl: './finance.page.html',
  styleUrl: './finance.page.scss',
})
export class FinancePage {
  protected readonly store = inject(FinanceStore);
  protected readonly context = inject(ProducerShowContext);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly composition = computed(() => {
    const state = this.store.statement();
    return state.status === 'ready' ? composition(state.value) : null;
  });

  constructor() {
    effect(() => {
      const id = this.context.id();
      if (id) {
        this.store.load(id);
      }
    });
  }

  /**
   * Os 8 últimos caracteres do ID, para achar o pedido no suporte. Os primeiros
   * não servem: num UUID v7 eles são o horário, iguais em pedidos do mesmo dia.
   */
  protected shortId(id: string): string {
    return id.slice(-8);
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
