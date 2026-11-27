import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { cartazPalette } from './cartaz-palette';
import { DateStamp } from './date-stamp';

/**
 * Tamanhos do cartaz:
 * - `hero`: o destaque da página inicial e o topo da página do show;
 * - `card`: a vitrine de shows (retrato 3:4);
 * - `faixa`: o cartaz deitado, de "Hoje à noite" e dos ingressos;
 * - `mini`: a miniatura do cabeçalho das telas de compra e do painel.
 */
export type CartazSize = 'hero' | 'card' | 'faixa' | 'mini';

/**
 * Cartaz de um show, no estilo lambe-lambe: o nome do artista em letras
 * altas, a tinta escolhida pelo nome dele, a retícula de impressão por cima e
 * o carimbo da data.
 *
 * O cartaz é decorativo (`aria-hidden`): quem o usa põe o nome do artista e a
 * data em texto ao lado, para leitores de tela. O conteúdo projetado entra na
 * base do cartaz (no `hero`, a linha de turnê e horário).
 */
@Component({
  selector: 'app-cartaz',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DateStamp],
  template: `
    @if (size() !== 'mini') {
      <div class="top">
        <span class="eyebrow where">{{ eyebrow() }}</span>
        @if (date(); as date) {
          <app-date-stamp [date]="date" [timezone]="timezone()" />
        }
      </div>
    }
    <p class="display artist">{{ artist() }}</p>
    <ng-content />
  `,
  host: {
    class: 'halftone',
    'aria-hidden': 'true',
    '[attr.data-size]': 'size()',
    '[attr.data-tinta]': 'palette().name',
    '[style.--cartaz-bg]': 'palette().background',
    '[style.--cartaz-ink]': 'palette().ink',
  },
  styleUrl: './cartaz.scss',
})
export class Cartaz {
  readonly artist = input.required<string>();
  /** Linha de cima, em monoespaçada: cidade, local. */
  readonly eyebrow = input<string>('');
  /** Instante do show em UTC; sem ele, o cartaz sai sem carimbo. */
  readonly date = input<string>();
  readonly timezone = input<string>();
  readonly size = input<CartazSize>('card');
  /** O que escolhe a tinta; por padrão, o artista. */
  readonly seed = input<string>();

  protected readonly palette = computed(() => cartazPalette(this.seed() ?? this.artist()));
}
