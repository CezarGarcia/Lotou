import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { GateSettings } from '../gate-settings';
import { ScanTone } from './scan-result';

/** Vibração de cada resultado (ms): curta libera, dupla avisa, longa barra. */
export const VIBRATION: Record<ScanTone, number[]> = {
  ok: [80],
  warn: [120, 80, 120],
  error: [400],
};

/** Bipes de cada resultado: frequência (Hz) e duração (ms) de cada nota. */
const BEEPS: Record<ScanTone, [number, number][]> = {
  ok: [[1_320, 120]],
  warn: [
    [880, 110],
    [880, 110],
  ],
  error: [[220, 450]],
};

/**
 * Retorno físico da leitura: vibração e bipe. Na fila da portaria, quem lê
 * olha para a pessoa, não para a tela.
 *
 * Os bipes são gerados com a Web Audio API (sem arquivo de som). O navegador
 * só deixa tocar depois de um gesto na página; o primeiro toque em "Ler" ou na
 * câmera já libera. Onde não há vibração (iPhone) ou som, nada acontece.
 */
@Injectable({ providedIn: 'root' })
export class GateFeedback {
  private readonly settings = inject(GateSettings);
  private readonly window = inject(DOCUMENT).defaultView;
  private audio?: AudioContext;

  signal(tone: ScanTone): void {
    try {
      this.window?.navigator.vibrate?.(VIBRATION[tone]);
    } catch {
      // Vibração bloqueada pelo navegador: segue sem ela.
    }
    if (this.settings.sound()) {
      this.beep(tone);
    }
  }

  /** Cria o contexto de áudio num gesto do usuário, para os bipes seguintes tocarem. */
  unlock(): void {
    try {
      this.context()?.resume();
    } catch {
      // Sem Web Audio: sem bipe.
    }
  }

  private context(): AudioContext | undefined {
    const Context = this.window?.AudioContext;
    if (!this.audio && Context) {
      this.audio = new Context();
    }
    return this.audio;
  }

  private beep(tone: ScanTone): void {
    try {
      const context = this.context();
      if (!context) {
        return;
      }
      let start = context.currentTime;
      for (const [frequency, ms] of BEEPS[tone]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'square';
        oscillator.frequency.value = frequency;
        gain.gain.value = 0.08;
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + ms / 1000);
        start += ms / 1000 + 0.06;
      }
    } catch {
      // Áudio indisponível: a cor e a vibração bastam.
    }
  }
}
