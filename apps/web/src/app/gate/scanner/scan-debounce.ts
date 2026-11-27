/** Por quanto tempo a mesma leitura da câmera é ignorada. */
export const SAME_CODE_WINDOW_MS = 5_000;

/**
 * A câmera vê o mesmo QR várias vezes por segundo enquanto a pessoa segura o
 * celular na frente dela. Sem isto, o segundo quadro já voltaria "já
 * utilizado" (amarelo) para quem acabou de entrar.
 *
 * A janela é deslizante: cada vez que a câmera vê o código, ela recomeça.
 * Então o código fica ignorado enquanto continua na frente da câmera e por
 * 5 s depois que sai dela. Códigos diferentes passam na hora.
 */
export class ScanDebouncer {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = SAME_CODE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** `true` se a leitura deve seguir; registra o código. */
  accept(code: string): boolean {
    const now = this.now();
    for (const [known, at] of this.seen) {
      if (now - at >= this.windowMs) {
        this.seen.delete(known);
      }
    }
    if (this.seen.has(code)) {
      this.seen.set(code, now);
      return false;
    }
    this.seen.set(code, now);
    return true;
  }

  /** Marca o código como visto agora (uma leitura manual também conta). */
  mark(code: string): void {
    this.seen.set(code, this.now());
  }
}
