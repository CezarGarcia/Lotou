import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { Router, RouterLink } from '@angular/router';
import { CountPipe } from '../../core/format/count.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { GateSettings, normalizeGate } from '../gate-settings';
import { CameraScanner } from './camera-scanner';
import { GateScannerStore } from './gate-scanner.store';
import { scanSentence } from './scan-result';

/**
 * O leitor da portaria: a câmera do celular, o código digitado (ou de um
 * leitor USB) e o resultado em tela cheia, verde, amarelo ou vermelho.
 * Feito para uma mão só, de pé, na fila: alvos grandes e pouco texto.
 */
@Component({
  selector: 'app-gate-scanner-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    CountPipe,
    ShowDatePipe,
    CameraScanner,
  ],
  providers: [GateScannerStore],
  templateUrl: './gate-scanner.page.html',
  styleUrl: './gate-scanner.page.scss',
  host: { '(document:keydown.escape)': 'store.dismiss()' },
})
export class GateScannerPage {
  protected readonly store = inject(GateScannerStore);
  protected readonly settings = inject(GateSettings);
  private readonly router = inject(Router);

  /** Parâmetro `:showId` da rota. */
  readonly showId = input.required<string>();
  /** Parâmetro `?portao=` da URL; sem ele, vale o portão guardado no aparelho. */
  readonly portao = input<string>();

  protected readonly gate = computed(
    () => normalizeGate(this.portao() ?? '') || this.settings.gate(),
  );

  protected readonly code = new FormControl('', { nonNullable: true });
  protected readonly form = new FormGroup({ code: this.code });
  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');

  protected readonly sentence = scanSentence;

  constructor() {
    effect(() => {
      const gate = this.gate();
      if (!gate) {
        // Sem portão, a leitura não tem onde ser registrada: volta à escolha.
        void this.router.navigate(['/portaria'], {
          queryParams: { show: this.showId() },
          replaceUrl: true,
        });
        return;
      }
      this.store.start(this.showId(), gate);
    });

    // Num computador (mouse), o campo já começa com o foco: um leitor USB
    // "digita" o código e dá Enter. No celular, isso abriria o teclado em cima da câmera.
    afterNextRender(() => {
      if (globalThis.matchMedia?.('(pointer: fine)').matches) {
        this.codeInput()?.nativeElement.focus();
      }
    });
  }

  protected submitManual(): void {
    if (this.store.submit(this.code.value, 'manual')) {
      this.code.setValue('');
    }
  }

  protected toggleSound(): void {
    this.settings.setSound(!this.settings.sound());
  }
}
