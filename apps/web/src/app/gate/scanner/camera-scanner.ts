import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCameraOff, lucideRotateCw } from '@ng-icons/lucide';
import { GET_USER_MEDIA, QR_DETECTOR_FACTORY, QrDetector } from './qr-detector';

/** Situação da câmera, para a tela explicar o que fazer. */
export type CameraState = 'starting' | 'running' | 'denied' | 'unavailable' | 'insecure' | 'error';

/** Intervalo entre leituras: o nativo é rápido; o jsQR roda na thread da página. */
export const SCAN_INTERVAL_MS = { native: 120, jsqr: 250 } as const;

const MESSAGES: Record<Exclude<CameraState, 'starting' | 'running'>, string> = {
  denied: 'A câmera foi bloqueada. Libere o acesso nas configurações do navegador e tente de novo.',
  unavailable: 'Nenhuma câmera disponível neste aparelho. Use o código digitado abaixo.',
  insecure: 'A câmera só funciona em uma conexão segura (HTTPS). Use o código digitado abaixo.',
  error: 'Não foi possível ligar a câmera. Tente de novo ou use o código digitado abaixo.',
};

/** Traduz o erro do `getUserMedia` para a situação da câmera. */
export function cameraErrorState(error: unknown): CameraState {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'denied';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'unavailable';
  }
  return 'error';
}

/**
 * A câmera traseira do celular lendo QR codes. Emite cada texto lido; quem
 * decide o que fazer (e ignorar repetições) é a tela. Com `paused`, continua
 * filmando mas não lê, para o resultado anterior ficar na tela.
 */
@Component({
  selector: 'app-camera-scanner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  viewProviders: [provideIcons({ lucideCameraOff, lucideRotateCw })],
  template: `
    <div class="frame" [attr.data-state]="state()">
      <video #video muted playsinline [muted]="true" aria-hidden="true"></video>
      @if (state() === 'running' || state() === 'starting') {
        <div class="target" aria-hidden="true">
          <span class="corner tl"></span>
          <span class="corner tr"></span>
          <span class="corner bl"></span>
          <span class="corner br"></span>
          @if (state() === 'running') {
            <span class="sweep"></span>
          }
        </div>
        <p class="hint" aria-live="polite">
          {{ state() === 'running' ? 'Aponte para o QR code do ingresso' : 'Ligando a câmera...' }}
        </p>
      } @else {
        <div class="problem" role="alert">
          <ng-icon name="lucideCameraOff" aria-hidden="true" />
          <p>{{ message() }}</p>
          @if (state() === 'denied' || state() === 'error') {
            <button class="btn btn-light" type="button" (click)="start()">
              <ng-icon name="lucideRotateCw" aria-hidden="true" />
              Tentar de novo
            </button>
          }
        </div>
      }
    </div>
  `,
  styleUrl: './camera-scanner.scss',
})
export class CameraScanner {
  private readonly getUserMedia = inject(GET_USER_MEDIA);
  private readonly detectorFactory = inject(QR_DETECTOR_FACTORY);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');

  /** Não lê enquanto o resultado anterior está na tela. */
  readonly paused = input(false);
  /** Texto de cada QR lido. Repetições do mesmo código saem várias vezes. */
  readonly scanned = output<string>();

  readonly state = signal<CameraState>('starting');
  protected readonly message = () => {
    const state = this.state();
    return state === 'starting' || state === 'running' ? '' : MESSAGES[state];
  };

  private stream?: MediaStream;
  private detector?: QrDetector;
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  /** Cada partida da câmera; uma partida antiga que termina tarde não vale mais. */
  private run = 0;

  constructor() {
    afterNextRender(() => void this.start());
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.stop();
    });
  }

  /** Liga a câmera traseira e começa a ler. */
  async start(): Promise<void> {
    this.stop();
    const run = ++this.run;
    if (!this.getUserMedia) {
      this.state.set(
        typeof isSecureContext === 'boolean' && !isSecureContext ? 'insecure' : 'unavailable',
      );
      return;
    }
    this.state.set('starting');
    try {
      const stream = await this.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (this.destroyed || run !== this.run) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const video = this.video().nativeElement;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // O `muted` + `playsinline` deixam tocar sem gesto; se o navegador
        // recusar, o vídeo ainda entrega quadros quando ficar visível.
      }
      this.detector ??= await this.detectorFactory();
      if (this.destroyed || run !== this.run) {
        return;
      }
      this.state.set('running');
      this.schedule(run);
    } catch (error) {
      if (run === this.run && !this.destroyed) {
        this.state.set(cameraErrorState(error));
      }
    }
  }

  private schedule(run: number): void {
    const delay = SCAN_INTERVAL_MS[this.detector?.kind ?? 'jsqr'];
    this.timer = setTimeout(() => void this.tick(run), delay);
  }

  private async tick(run: number): Promise<void> {
    if (this.destroyed || run !== this.run || !this.detector) {
      return;
    }
    if (!this.paused()) {
      try {
        const text = await this.detector.detect(this.video().nativeElement);
        if (text && !this.paused() && run === this.run && !this.destroyed) {
          this.scanned.emit(text);
        }
      } catch {
        // Um quadro ruim não para a leitura.
      }
    }
    if (!this.destroyed && run === this.run) {
      this.schedule(run);
    }
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
}
