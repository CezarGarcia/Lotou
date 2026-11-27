import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';

const GATE_KEY = 'lotou.portaria.portao';
const SOUND_KEY = 'lotou.portaria.som';

/** Nome de portão aceito: o mesmo limite que o campo da tela. */
export const GATE_MAX_LENGTH = 40;

/**
 * Preferências do aparelho da portaria, guardadas no `localStorage`: o portão
 * (quem trabalha no Portão B abre o leitor amanhã já no Portão B) e o som.
 *
 * Nada de dado pessoal aqui. Sem `localStorage` (aba anônima bloqueada), a
 * tela funciona do mesmo jeito, só sem lembrar.
 */
@Injectable({ providedIn: 'root' })
export class GateSettings {
  private readonly document = inject(DOCUMENT);

  readonly gate = signal(this.read(GATE_KEY) ?? '');
  readonly sound = signal(this.read(SOUND_KEY) !== 'off');

  setGate(gate: string): void {
    const value = normalizeGate(gate);
    this.gate.set(value);
    this.write(GATE_KEY, value);
  }

  setSound(on: boolean): void {
    this.sound.set(on);
    this.write(SOUND_KEY, on ? 'on' : 'off');
  }

  private storage(): Storage | undefined {
    try {
      return this.document.defaultView?.localStorage;
    } catch {
      return undefined;
    }
  }

  private read(key: string): string | null {
    try {
      return this.storage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.storage()?.setItem(key, value);
    } catch {
      // Sem espaço ou bloqueado: a preferência vale só nesta aba.
    }
  }
}

/** "  portão   b " vira "portão b": espaços colapsados e no máximo 40 caracteres. */
export function normalizeGate(gate: string): string {
  return gate.replace(/\s+/g, ' ').trim().slice(0, GATE_MAX_LENGTH);
}
