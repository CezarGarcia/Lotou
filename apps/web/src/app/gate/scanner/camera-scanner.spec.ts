import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CameraScanner, SCAN_INTERVAL_MS, cameraErrorState } from './camera-scanner';
import { GET_USER_MEDIA, QR_DETECTOR_FACTORY, QrDetector } from './qr-detector';

@Component({
  imports: [CameraScanner],
  template: `<app-camera-scanner [paused]="paused()" (scanned)="codes.push($event)" />`,
})
class Host {
  readonly paused = signal(false);
  readonly codes: string[] = [];
}

/** Um vídeo falso: as faixas da câmera, para conferir que foram desligadas. */
function fakeStream() {
  const track = { stop: vi.fn() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

describe('CameraScanner', () => {
  let fixture: ComponentFixture<Host>;
  let frames: (string | null)[];
  let detector: QrDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    frames = [];
    // O leitor falso devolve, a cada quadro, o próximo valor da lista.
    detector = { kind: 'native', detect: vi.fn(async () => frames.shift() ?? null) };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function render(getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>) {
    TestBed.configureTestingModule({
      providers: [
        { provide: GET_USER_MEDIA, useValue: getUserMedia },
        { provide: QR_DETECTOR_FACTORY, useValue: () => Promise.resolve(detector) },
      ],
    });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  }

  const text = () => (fixture.nativeElement as HTMLElement).textContent!;

  it('pede a câmera traseira e emite cada QR lido', async () => {
    const { stream } = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    await render(getUserMedia);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    expect(text()).toContain('Aponte para o QR code');

    frames.push(null, 'LOTOU1.t1.sig');
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL_MS.native * 2);
    expect(fixture.componentInstance.codes).toEqual(['LOTOU1.t1.sig']);
  });

  it('pausada, não lê', async () => {
    await render(vi.fn().mockResolvedValue(fakeStream().stream));
    fixture.componentInstance.paused.set(true);
    fixture.detectChanges();
    frames.push('A', 'A', 'A');
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL_MS.native * 3);
    expect(fixture.componentInstance.codes).toEqual([]);
    expect(detector.detect).not.toHaveBeenCalled();

    fixture.componentInstance.paused.set(false);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL_MS.native);
    expect(fixture.componentInstance.codes).toEqual(['A']);
  });

  it('explica a câmera bloqueada e deixa tentar de novo', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('negado'), { name: 'NotAllowedError' }))
      .mockResolvedValue(fakeStream().stream);
    await render(getUserMedia);
    expect(text()).toContain('A câmera foi bloqueada');
    const alert = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
    expect(alert).not.toBeNull();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button')!.click();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Aponte para o QR code');
  });

  it('sem câmera no navegador, manda usar o código digitado', async () => {
    await render(undefined);
    expect(text()).toMatch(/Nenhuma câmera disponível|conexão segura/);
  });

  it('desliga a câmera ao sair da tela', async () => {
    const { stream, track } = fakeStream();
    await render(vi.fn().mockResolvedValue(stream));
    fixture.destroy();
    expect(track.stop).toHaveBeenCalled();
    // Depois de destruída, não lê mais.
    frames.push('A');
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL_MS.native * 2);
    expect(detector.detect).not.toHaveBeenCalled();
  });
});

describe('cameraErrorState', () => {
  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'unavailable'],
    ['OverconstrainedError', 'unavailable'],
    ['NotReadableError', 'error'],
  ])('%s vira %s', (name, state) => {
    expect(cameraErrorState({ name })).toBe(state);
  });
});
