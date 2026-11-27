import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { RESULT_MS, ScanRecord } from './gate-scanner.store';
import { SCAN_ICONS, clockOf } from './scan-result';

/**
 * O resultado da leitura em tela cheia, para ser lido de longe: a cor (verde
 * libera, amarelo já entrou, vermelho barra), o título enorme, o ingresso e o
 * que fazer. A barra do topo encolhe no tempo em que a tela volta sozinha ao
 * leitor. Tocar em qualquer lugar também volta.
 */
@Component({
  selector: 'app-scan-result-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  viewProviders: [provideIcons(SCAN_ICONS)],
  template: `
    @let view = record().view;
    <div
      class="result"
      [attr.data-tone]="view.tone"
      [style.--tempo]="duration()"
      (click)="next.emit()"
    >
      <div class="tempo" aria-hidden="true"></div>
      <p class="top mono" aria-hidden="true">
        <span>{{ gate() }} · {{ clock() }}</span>
        <span class="artist">{{ artist() }}</span>
      </p>

      <div class="body">
        <ng-icon [name]="view.icon" aria-hidden="true" />
        <h2 class="display title">{{ view.title }}</h2>
        @if (view.detail) {
          <p class="detail">{{ view.detail }}</p>
        }
        @if (view.place || view.ticket) {
          <dl>
            @if (view.place) {
              <div>
                <dt class="eyebrow">Setor</dt>
                <dd>{{ view.place }}</dd>
              </div>
            }
            @if (view.ticket) {
              <div>
                <dt class="eyebrow">Ingresso</dt>
                <dd class="mono">{{ view.ticket }}</dd>
              </div>
            }
          </dl>
        }
        @if (view.advice) {
          <p class="advice">{{ view.advice }}</p>
        }
      </div>

      <button type="button" class="next" (click)="next.emit(); $event.stopPropagation()">
        Próxima leitura
      </button>
    </div>
  `,
  styleUrl: './scan-result-screen.scss',
})
export class ScanResultScreen {
  readonly record = input.required<ScanRecord>();
  readonly gate = input('');
  readonly artist = input('');
  readonly timezone = input<string>();
  /** A pessoa tocou na tela ou em "Próxima leitura". */
  readonly next = output();

  protected readonly clock = computed(() => clockOf(this.record().at, this.timezone()));
  /** O mesmo tempo que o leitor espera antes de tirar o resultado da tela. */
  protected readonly duration = computed(() => `${RESULT_MS[this.record().view.tone]}ms`);
}
