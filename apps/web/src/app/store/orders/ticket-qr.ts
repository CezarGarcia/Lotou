import { ChangeDetectionStrategy, Component, input, resource } from '@angular/core';

/** Os módulos (quadradinhos) de um QR code, prontos para desenhar. */
export interface QrMatrix {
  size: number;
  /** Caminho SVG com um quadrado de 1x1 por módulo escuro. */
  path: string;
}

/** Zona de silêncio em volta do código, em módulos (a norma pede 4; 2 basta em tela). */
const QUIET_ZONE = 2;

/**
 * Gera a matriz do QR. A biblioteca `qrcode` é importada sob demanda: vira um
 * pacote próprio, baixado só quando um ingresso com código aparece na tela.
 */
export async function qrMatrix(text: string): Promise<QrMatrix> {
  const { create } = await import('qrcode');
  // Nível M: aguenta ~15% de dano (tela riscada, reflexo) sem engrossar demais o código.
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  let path = '';
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) {
        path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
  }
  return { size: modules.size + QUIET_ZONE * 2, path };
}

/**
 * QR code de um ingresso, desenhado em SVG pelo Angular (sem `innerHTML`).
 * Preto sobre branco mesmo no tema escuro: é o que os leitores da portaria
 * leem melhor. Ingressos antigos, emitidos antes do código assinado, mostram
 * "QR indisponível".
 */
@Component({
  selector: 'app-ticket-qr',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!code()) {
      <p class="fallback">QR indisponível</p>
    } @else if (matrix.hasValue()) {
      @let qr = matrix.value();
      <svg
        role="img"
        [attr.aria-label]="label()"
        [attr.viewBox]="'0 0 ' + qr.size + ' ' + qr.size"
        shape-rendering="crispEdges"
      >
        <rect [attr.width]="qr.size" [attr.height]="qr.size" fill="#fff" />
        <path [attr.d]="qr.path" fill="#000" />
      </svg>
    } @else if (matrix.error()) {
      <p class="fallback" role="alert">Não foi possível gerar o QR</p>
    } @else {
      <div class="placeholder" aria-hidden="true"></div>
    }
  `,
  styles: `
    :host {
      display: block;
      width: var(--qr-size, 160px);
      aspect-ratio: 1;
    }
    svg,
    .placeholder,
    .fallback {
      display: block;
      width: 100%;
      height: 100%;
      border-radius: 12px;
    }
    .placeholder {
      background: var(--mat-sys-surface-container-high);
    }
    .fallback {
      display: grid;
      place-items: center;
      margin: 0;
      padding: 12px;
      border: 2px dashed var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-large);
      text-align: center;
    }
  `,
})
export class TicketQr {
  /** O código assinado do ingresso (`LOTOU1.<ticketId>.<assinatura>`). */
  readonly code = input<string | null | undefined>();
  /** Descrição para leitores de tela. */
  readonly label = input('QR code do ingresso');

  protected readonly matrix = resource({
    params: () => this.code() || undefined,
    loader: ({ params }) => qrMatrix(params),
  });
}
