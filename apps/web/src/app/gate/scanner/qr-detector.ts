import { InjectionToken } from '@angular/core';

/** Quem lê o QR de um quadro do vídeo. */
export interface QrDetector {
  /** `native` é o `BarcodeDetector` do navegador; `jsqr`, a biblioteca. */
  readonly kind: 'native' | 'jsqr';
  /** O texto do primeiro QR no quadro, ou `null` (sem QR, ou o vídeo ainda não tem imagem). */
  detect(video: HTMLVideoElement): Promise<string | null>;
}

/** O que o `BarcodeDetector` expõe (ainda fora dos tipos do TypeScript). */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

/** O vídeo já tem um quadro para ler. */
const hasFrame = (video: HTMLVideoElement) =>
  video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;

/** Lado maior do quadro entregue ao jsQR: o bastante para um QR a um palmo da câmera. */
const JSQR_MAX_SIDE = 640;

/**
 * Leitor com o `BarcodeDetector` nativo (Chrome no Android, Safari recente):
 * roda fora da thread da página e não custa nenhum byte de pacote.
 */
async function nativeDetector(win: Window): Promise<QrDetector | null> {
  const Detector = (win as unknown as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (!Detector) {
    return null;
  }
  try {
    const formats = (await Detector.getSupportedFormats?.()) ?? ['qr_code'];
    if (!formats.includes('qr_code')) {
      return null;
    }
    const detector = new Detector({ formats: ['qr_code'] });
    return {
      kind: 'native',
      detect: async (video) => {
        if (!hasFrame(video)) {
          return null;
        }
        const [first] = await detector.detect(video);
        return first?.rawValue || null;
      },
    };
  } catch {
    return null;
  }
}

/**
 * Leitor com o jsQR, para navegadores sem `BarcodeDetector` (Firefox, Safari
 * antigo). A biblioteca é importada sob demanda: vira um pacote próprio,
 * baixado só na portaria e só nesses navegadores.
 */
async function jsqrDetector(win: Window): Promise<QrDetector> {
  const module = await import('jsqr');
  // CommonJS: no build de produção a função chega em `default`; nos testes e no
  // servidor de desenvolvimento, às vezes, o próprio módulo é a função.
  const jsQR = (typeof module.default === 'function' ? module.default : module) as unknown as (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options?: { inversionAttempts?: 'dontInvert' | 'attemptBoth' },
  ) => { data: string } | null;
  const canvas = win.document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return {
    kind: 'jsqr',
    detect: async (video) => {
      if (!context || !hasFrame(video)) {
        return null;
      }
      const scale = Math.min(1, JSQR_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      // O QR do Lotou é preto no branco: pular a tentativa invertida dobra a velocidade.
      return (
        jsQR(data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })?.data || null
      );
    },
  };
}

/** O melhor leitor disponível: o nativo e, sem ele, o jsQR. */
export async function createQrDetector(win: Window = window): Promise<QrDetector> {
  return (await nativeDetector(win)) ?? jsqrDetector(win);
}

/** Fábrica do leitor; os testes trocam por um falso. */
export const QR_DETECTOR_FACTORY = new InjectionToken<() => Promise<QrDetector>>(
  'QR_DETECTOR_FACTORY',
  { providedIn: 'root', factory: () => () => createQrDetector() },
);

/** Acesso à câmera; os testes trocam por um falso. `undefined` sem suporte no navegador. */
export const GET_USER_MEDIA = new InjectionToken<
  ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | undefined
>('GET_USER_MEDIA', {
  providedIn: 'root',
  factory: () => {
    const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    return devices?.getUserMedia ? devices.getUserMedia.bind(devices) : undefined;
  },
});
