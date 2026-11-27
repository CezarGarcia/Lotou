import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

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
    MatIconModule,
    MatInputModule,
  ],
  template: `
    <h2 mat-dialog-title>Cancelar o show?</h2>
    <mat-dialog-content>
      <div class="warning" role="note">
        <mat-icon aria-hidden="true">warning</mat-icon>
        <p>Esta ação não pode ser desfeita.</p>
      </div>
      <ul>
        <li>As vendas param na hora e o show sai da loja como cancelado.</li>
        <li>
          Todo pedido confirmado é reembolsado automaticamente, com a taxa de serviço, e o comprador
          recebe um e-mail quando o dinheiro voltar.
        </li>
        <li>
          Os reembolsos saem aos poucos, para não sobrecarregar o meio de pagamento: acompanhe no
          Financeiro.
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
    .warning {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px 12px;
      border-radius: 12px;
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .warning p {
      margin: 0;
      font-weight: 600;
    }
    ul {
      display: grid;
      gap: 6px;
      padding-left: 20px;
    }
    mat-form-field {
      width: 100%;
    }
    .danger {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
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
