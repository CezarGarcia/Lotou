import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBan, lucideClock, lucideRotateCcw, lucideTriangleAlert } from '@ng-icons/lucide';

export interface CancelShowData {
  title: string;
  artist: string;
}

/** Compara o nome digitado com o do show, sem ligar para maiúsculas e espaços. */
export function matchesShowName(typed: string, title: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR');
  return normalize(title) !== '' && normalize(typed) === normalize(title);
}

/**
 * Confirmação forte do cancelamento do show: a ação não volta atrás e
 * reembolsa todos os pedidos. O botão só libera depois de digitar o nome do
 * show, como o GitHub faz para apagar um repositório.
 */
@Component({
  selector: 'app-cancel-show-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    NgIcon,
  ],
  viewProviders: [provideIcons({ lucideBan, lucideClock, lucideRotateCcw, lucideTriangleAlert })],
  template: `
    <h2 mat-dialog-title>Cancelar o show?</h2>
    <mat-dialog-content>
      <p class="show">
        <strong>{{ data.artist }}</strong> · {{ data.title }}
      </p>
      <div class="warning" role="note">
        <ng-icon name="lucideTriangleAlert" aria-hidden="true" />
        <p>Esta ação não pode ser desfeita.</p>
      </div>
      <ul>
        <li>
          <ng-icon name="lucideBan" aria-hidden="true" />
          <span>As vendas param na hora e o show sai da loja como cancelado.</span>
        </li>
        <li>
          <ng-icon name="lucideRotateCcw" aria-hidden="true" />
          <span>
            Todo pedido confirmado é reembolsado automaticamente, com a taxa de serviço, e o
            comprador recebe um e-mail quando o dinheiro voltar.
          </span>
        </li>
        <li>
          <ng-icon name="lucideClock" aria-hidden="true" />
          <span>
            Os reembolsos saem aos poucos, para não sobrecarregar o meio de pagamento: acompanhe no
            Financeiro.
          </span>
        </li>
      </ul>
      <mat-form-field appearance="outline" subscriptSizing="dynamic">
        <mat-label>Digite o nome do show para confirmar</mat-label>
        <input
          matInput
          [formControl]="typed"
          autocomplete="off"
          spellcheck="false"
          (keydown.enter)="confirm()"
        />
        <mat-hint
          >Nome do show: <strong>{{ data.title }}</strong></mat-hint
        >
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton type="button" [mat-dialog-close]="false">Voltar</button>
      <button
        matButton="filled"
        type="button"
        class="danger"
        [disabled]="!matches()"
        (click)="confirm()"
      >
        Cancelar show e reembolsar
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    :host {
      --mat-dialog-subhead-font: var(--lt-display);
      --mat-dialog-subhead-size: 2.25rem;
      --mat-dialog-subhead-weight: 900;
      --mat-dialog-subhead-line-height: 1;
    }
    h2 {
      text-transform: uppercase;
    }
    .show {
      margin: 0 0 16px;
      color: var(--lt-muted);
    }
    .show strong {
      color: var(--lt-text);
    }
    .warning {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 12px 14px;
      border: 1px solid #f2c4c4;
      border-radius: 14px;
      background: var(--lt-danger-soft);
      color: #7a1414;
    }
    .warning ng-icon {
      font-size: 20px;
    }
    .warning p {
      margin: 0;
      font-weight: 700;
    }
    ul {
      display: grid;
      gap: 12px;
      margin: 18px 0 20px;
      padding: 0;
      list-style: none;
      color: var(--lt-text-2);
    }
    li {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    li ng-icon {
      margin-top: 2px;
      font-size: 18px;
      color: var(--lt-muted);
    }
    mat-form-field {
      width: 100%;
    }
    mat-hint strong {
      font-family: var(--lt-mono);
      color: var(--lt-text);
    }
    .danger {
      --mat-button-filled-container-color: var(--lt-danger);
      --mat-button-filled-label-text-color: #ffffff;
    }
  `,
})
export class CancelShowDialog {
  protected readonly data = inject<CancelShowData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<CancelShowDialog, boolean>>(MatDialogRef);

  protected readonly typed = new FormControl('', { nonNullable: true });
  private readonly value = toSignal(this.typed.valueChanges, { initialValue: '' });
  protected readonly matches = computed(() => matchesShowName(this.value(), this.data.title));

  protected confirm(): void {
    if (this.matches()) {
      this.ref.close(true);
    }
  }
}
