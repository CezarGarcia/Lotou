import { create } from 'qrcode';
import jsQR from 'jsqr';
import { createQrDetector } from './qr-detector';

/** Um vídeo com quadro: o que o leitor precisa para tentar ler. */
const video = (ready = true) =>
  ({
    readyState: ready ? 4 : 0,
    videoWidth: ready ? 640 : 0,
    videoHeight: ready ? 480 : 0,
  }) as HTMLVideoElement;

/** Uma janela falsa, com ou sem `BarcodeDetector`. */
function fakeWindow(detector?: { formats: string[]; found: string[] }) {
  const { formats = [], found = [] } = detector ?? {};
  const BarcodeDetector = detector
    ? class {
        static getSupportedFormats = async () => formats;
        detect = async () => found.map((rawValue) => ({ rawValue }));
      }
    : undefined;
  return { BarcodeDetector, document } as unknown as Window;
}

describe('createQrDetector', () => {
  it('usa o BarcodeDetector do navegador quando ele lê QR', async () => {
    const reader = await createQrDetector(
      fakeWindow({ formats: ['qr_code'], found: ['LOTOU1.a.b'] }),
    );
    expect(reader.kind).toBe('native');
    expect(await reader.detect(video())).toBe('LOTOU1.a.b');
    // Sem quadro ainda, nem tenta.
    expect(await reader.detect(video(false))).toBeNull();
  });

  it('cai para o jsQR sem BarcodeDetector, ou quando ele não lê QR', async () => {
    expect((await createQrDetector(fakeWindow())).kind).toBe('jsqr');
    expect((await createQrDetector(fakeWindow({ formats: ['ean_13'], found: [] }))).kind).toBe(
      'jsqr',
    );
  });
});

describe('jsQR com o QR do ingresso', () => {
  it('lê o QR que a página do pedido desenha', () => {
    const text = 'LOTOU1.01a21a00-0000-7000-8000-000000000013.c2lnbmF0dXJl';
    const { modules } = create(text, { errorCorrectionLevel: 'M' });
    // Desenha a matriz em pixels RGBA, 4 px por módulo, com zona de silêncio.
    const scale = 4;
    const quiet = 4;
    const side = (modules.size + quiet * 2) * scale;
    const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (!modules.get(row, col)) {
          continue;
        }
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const px = (col + quiet) * scale + x;
            const py = (row + quiet) * scale + y;
            const offset = (py * side + px) * 4;
            pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
          }
        }
      }
    }
    expect(jsQR(pixels, side, side, { inversionAttempts: 'dontInvert' })?.data).toBe(text);
  });
});
