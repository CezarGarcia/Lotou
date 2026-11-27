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
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router, RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronLeft, lucideVolume2, lucideVolumeX } from '@ng-icons/lucide';
import { AuthService } from '../../core/auth/auth.service';
import { CountPipe } from '../../core/format/count.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { GateSettings, normalizeGate, parseSectorList } from '../gate-settings';
import { GateOfflineStore } from '../offline/gate-offline.store';
import { sectorsOf } from '../offline/offline-package';
import { OfflineStatus } from '../offline/offline-status';
import { CameraScanner } from './camera-scanner';
import { GateScannerStore } from './gate-scanner.store';
import { clockOf, scanSentence } from './scan-result';
import { ScanResultScreen } from './scan-result-screen';

/**
 * O leitor da portaria: a câmera do celular, o código digitado (ou de um
 * leitor USB) e o resultado em tela cheia, verde, amarelo ou vermelho.
 * Feito para uma mão só, de pé, na fila: alvos grandes e pouco texto. Abre
 * em modo foco (sem o cabeçalho do app), então tem o próprio topo, com a
 * volta para a escolha do show e do portão, e a faixa que diz se a leitura
 * vai ao servidor ou é decidida no aparelho (ADR 38).
 */
@Component({
  selector: 'app-gate-scanner-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatFormFieldModule,
    MatInputModule,
    NgIcon,
    CountPipe,
    ShowDatePipe,
    CameraScanner,
    ScanResultScreen,
    OfflineStatus,
  ],
  providers: [GateScannerStore, GateOfflineStore],
  viewProviders: [provideIcons({ lucideChevronLeft, lucideVolume2, lucideVolumeX })],
  templateUrl: './gate-scanner.page.html',
  styleUrl: './gate-scanner.page.scss',
  host: { '(document:keydown.escape)': 'store.dismiss()' },
})
export class GateScannerPage {
  protected readonly store = inject(GateScannerStore);
  protected readonly settings = inject(GateSettings);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  /** Parâmetro `:showId` da rota. */
  readonly showId = input.required<string>();
  /** Parâmetro `?portao=` da URL; sem ele, vale o portão guardado no aparelho. */
  readonly portao = input<string>();
  /** Parâmetro `?setores=a,b`: os setores deste portão; sem ele, os guardados no aparelho. */
  readonly setores = input<string>();

  protected readonly gate = computed(
    () => normalizeGate(this.portao() ?? '') || this.settings.gate(),
  );
  protected readonly sectors = computed(() => {
    const fromUrl = parseSectorList(this.setores());
    return fromUrl.length > 0 ? fromUrl : this.settings.sectorsFor(this.showId());
  });
  /** Os nomes dos setores deste portão, pelo pacote; vazio quando são todos. */
  protected readonly sectorNames = computed(() => {
    const ids = this.sectors();
    return sectorsOf(this.store.offline.stored()?.pkg ?? null)
      .filter((sector) => ids.includes(sector.id))
      .map((sector) => sector.name);
  });

  protected readonly code = new FormControl('', { nonNullable: true });
  protected readonly form = new FormGroup({ code: this.code });
  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');

  protected readonly sentence = scanSentence;
  protected readonly clock = clockOf;

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
      this.store.start(this.showId(), gate, this.sectors());
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

  protected login(): void {
    this.auth.login();
  }

  protected toggleSound(): void {
    this.settings.setSound(!this.settings.sound());
  }
}
