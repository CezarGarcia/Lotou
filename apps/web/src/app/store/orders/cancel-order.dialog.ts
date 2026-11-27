import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';

export interface CancelOrderData {
  /** O que volta ao comprador: o total pago, com a taxa. */
  totalCents: number;
  tickets: number;
  /** Até quando o pedido pode ser cancelado (UTC), se o servidor informou. */
  deadline: string | null;
  timezone: string | undefined;
}

/**
 * Confirmação do cancelamento, com a política em palavras simples. O botão em
 * foco ao abrir é o de manter o pedido: Enter não cancela por engano.
 */
@Component({
  selector: 'app-cancel-order-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDialogModule, MatButtonModule, MatIconModule, MoneyPipe, ShowDatePipe],
  template: `
    <h2 mat-dialog-title>Cancelar o pedido?</h2>
    <mat-dialog-content>
      <p>
        O cancelamento vale para o pedido inteiro:
        {{ data.tickets === 1 ? 'o ingresso deixa' : 'os ' + data.tickets + ' ingressos deixam' }}
        de valer na hora e não pode ser desfeito.
      </p>
      <ul>
        <li>
          <mat-icon aria-hidden="true">payments</mat-icon>
          <span
            >Reembolso integral de <strong>{{ data.totalCents | brl }}</strong>, taxa de serviço
            incluída, na forma de pagamento da compra.</span
          >
        </li>
        <li>
          <mat-icon aria-hidden="true">event_available</mat-icon>
          <span
            >A política: cancelamento até 7 dias depois da compra, desde que faltem mais de 48 horas
            para o show.
            @if (data.deadline) {
              Para este pedido, até
              {{ data.deadline | showDate: data.timezone : 'date' }} às
              {{ data.deadline | showDate: data.timezone : 'time' }}.
            }
          </span>
        </li>
        <li>
          <mat-icon aria-hidden="true">mail</mat-icon>
          <span>Avisamos por e-mail quando o reembolso for concluído.</span>
        </li>
      </ul>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton type="button" [mat-dialog-close]="false" cdkFocusInitial>
        Manter pedido
      </button>
      <button matButton="filled" type="button" class="danger" [mat-dialog-close]="true">
        Cancelar e pedir reembolso
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    p {
      margin: 0 0 12px;
    }
    ul {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    mat-icon {
      flex: none;
      color: var(--mat-sys-primary);
    }
    .danger {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
    }
  `,
})
export class CancelOrderDialog {
  protected readonly data = inject<CancelOrderData>(MAT_DIALOG_DATA);
}
