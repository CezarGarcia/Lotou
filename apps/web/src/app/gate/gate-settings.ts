import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { uuidv7 } from '../core/http/idempotency';

const GATE_KEY = 'lotou.portaria.portao';
const SOUND_KEY = 'lotou.portaria.som';
const SECTORS_KEY = 'lotou.portaria.setores';
const DEVICE_KEY = 'lotou.portaria.aparelho';

/** Os setores que o portão atende num show; vazio, todos. */
export interface GateSectors {
  showId: string;
  ids: string[];
}

/** Nome de portão aceito: o mesmo limite que o campo da tela. */
export const GATE_MAX_LENGTH = 40;

/**
 * Preferências do aparelho da portaria, guardadas no `localStorage`: o portão
 * (quem trabalha no Portão B abre o leitor amanhã já no Portão B), os setores
 * que ele atende, o som e o id do aparelho, que vai com as leituras feitas
 * sem internet.
 *
 * Nada de dado pessoal aqui. Sem `localStorage` (aba anônima bloqueada), a
 * tela funciona do mesmo jeito, só sem lembrar.
 */
@Injectable({ providedIn: 'root' })
export class GateSettings {
  private readonly document = inject(DOCUMENT);

  readonly gate = signal(this.read(GATE_KEY) ?? '');
  readonly sound = signal(this.read(SOUND_KEY) !== 'off');
  readonly sectors = signal<GateSectors | null>(parseSectors(this.read(SECTORS_KEY)));
  private device = this.read(DEVICE_KEY) ?? '';

  setGate(gate: string): void {
    const value = normalizeGate(gate);
    this.gate.set(value);
    this.write(GATE_KEY, value);
  }

  setSound(on: boolean): void {
    this.sound.set(on);
    this.write(SOUND_KEY, on ? 'on' : 'off');
  }

  /** Os setores deste portão no show (vazio, todos). */
  sectorsFor(showId: string): string[] {
    const saved = this.sectors();
    return saved?.showId === showId ? saved.ids : [];
  }

  setSectors(showId: string, ids: readonly string[]): void {
    const value = { showId, ids: [...ids] };
    this.sectors.set(value);
    this.write(SECTORS_KEY, JSON.stringify(value));
  }

  /** Um UUID gerado uma vez e guardado: identifica o aparelho nas leituras sem internet. */
  deviceId(): string {
    if (!this.device) {
      this.device = uuidv7();
      this.write(DEVICE_KEY, this.device);
    }
    return this.device;
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

/** `?setores=a,b` vira `['a', 'b']`; vazio ou ausente, todos os setores. */
export function parseSectorList(value: string | null | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

function parseSectors(raw: string | null): GateSectors | null {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<GateSectors> | null;
    return typeof value?.showId === 'string' && Array.isArray(value.ids)
      ? { showId: value.showId, ids: value.ids.filter((id) => typeof id === 'string') }
      : null;
  } catch {
    return null;
  }
}
