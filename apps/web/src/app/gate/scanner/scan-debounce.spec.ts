import { SAME_CODE_WINDOW_MS, ScanDebouncer } from './scan-debounce';

describe('ScanDebouncer', () => {
  let now: number;
  let debouncer: ScanDebouncer;

  beforeEach(() => {
    now = 1_000;
    debouncer = new ScanDebouncer(SAME_CODE_WINDOW_MS, () => now);
  });

  it('ignora o mesmo código dentro da janela', () => {
    expect(debouncer.accept('A')).toBe(true);
    now += 100;
    expect(debouncer.accept('A')).toBe(false);
    now += SAME_CODE_WINDOW_MS - 200;
    expect(debouncer.accept('A')).toBe(false);
  });

  it('aceita o mesmo código depois da janela', () => {
    debouncer.accept('A');
    now += SAME_CODE_WINDOW_MS;
    expect(debouncer.accept('A')).toBe(true);
  });

  it('códigos diferentes passam na hora', () => {
    expect(debouncer.accept('A')).toBe(true);
    expect(debouncer.accept('B')).toBe(true);
    expect(debouncer.accept('A')).toBe(false);
  });

  it('enquanto o código continua na frente da câmera, a janela recomeça', () => {
    debouncer.accept('A');
    now += 3_000;
    expect(debouncer.accept('A')).toBe(false);
    now += 3_000;
    // 6 s depois da primeira leitura, mas só 3 s depois da última vez que foi visto.
    expect(debouncer.accept('A')).toBe(false);
    now += SAME_CODE_WINDOW_MS;
    expect(debouncer.accept('A')).toBe(true);
  });

  it('uma leitura manual marca o código para a câmera', () => {
    debouncer.mark('A');
    expect(debouncer.accept('A')).toBe(false);
  });
});
