import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBanknote, lucideCalendarCheck, lucideMail } from '@ng-icons/lucide';
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
  imports: [MatDialogModule, MatButtonModule, NgIcon, MoneyPipe, ShowDatePipe],
  viewProviders: [provideIcons({ lucideBanknote, lucideCalendarCheck, lucideMail })],
  template: `
    <h2 mat-dialog-title class="title">Cancelar o pedido?</h2>
    <mat-dialog-content>
      <p>
        O cancelamento vale para o pedido inteiro:
        {{ data.tickets === 1 ? 'o ingresso deixa' : 'os ' + data.tickets + ' ingressos deixam' }}
        de valer na hora e não pode ser desfeito.
      </p>
      <ul>
        <li>
          <ng-icon name="lucideBanknote" aria-hidden="true" />
          <span
            >Reembolso integral de <strong>{{ data.totalCents | brl }}</strong>, taxa de serviço
            incluída, na forma de pagamento da compra.</span
          >
        </li>
        <li>
          <ng-icon name="lucideCalendarCheck" aria-hidden="true" />
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
          <ng-icon name="lucideMail" aria-hidden="true" />
          <span>Avisamos por e-mail quando o reembolso for concluído.</span>
        </li>
      </ul>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton="outlined" type="button" [mat-dialog-close]="false" cdkFocusInitial>
        Manter pedido
      </button>
      <button matButton="filled" type="button" class="danger" [mat-dialog-close]="true">
        Cancelar e pedir reembolso
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .title {
      font-family: var(--lt-display);
      font-size: 2.25rem;
      font-weight: 900;
      line-height: 1.1;
      text-transform: uppercase;
    }
    p {
      margin: 0 0 16px;
      color: var(--lt-text-2);
    }
    ul {
      display: grid;
      gap: 12px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      padding: 12px 14px;
      border-radius: 14px;
      background: var(--lt-raised);
      color: var(--lt-text-2);
    }
    li:first-child {
      background: var(--lt-ok-soft);
    }
    li:first-child ng-icon {
      color: var(--lt-ok);
    }
    ng-icon {
      flex: none;
      margin-top: 2px;
      font-size: 1.25rem;
      color: var(--lt-text-3);
    }
    strong {
      color: var(--lt-text);
      font-variant-numeric: tabular-nums;
    }
    mat-dialog-actions {
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px 24px 24px;
    }
    .danger {
      --mat-button-filled-container-color: var(--lt-danger);
      --mat-button-filled-label-text-color: #121015;
    }
  `,
})
export class CancelOrderDialog {
  protected readonly data = inject<CancelOrderData>(MAT_DIALOG_DATA);
}
