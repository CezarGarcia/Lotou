import { Signal, WritableSignal, computed, signal } from '@angular/core';
import { SeatChange, SeatStatus } from '../data/sale.models';
import { SeatRow } from '../data/show.models';

/** Máximo de cadeiras numa reserva (e por CPF em cada show). */
export const MAX_SEATS = 4;

export interface SeatView {
  /** `{fileira}-{n}`, como `A-12`: é o nome que a API usa. */
  label: string;
  row: string;
  number: number;
  rowIndex: number;
  /** Posição na fileira, a partir de 0. */
  index: number;
  /** Coluna no desenho, em unidades de cadeira. Fileiras curtas ficam centralizadas. */
  column: number;
  /** `null` enquanto a foto do setor não chegou. */
  available: Signal<boolean | null>;
}

export interface RowView {
  label: string;
  index: number;
  seats: SeatView[];
}

export type ToggleResult = 'selected' | 'deselected' | 'unavailable' | 'limit' | 'unknown';

export type Direction = 'left' | 'right' | 'up' | 'down' | 'home' | 'end';

/**
 * Estado do mapa de cadeiras de um setor: o desenho (fileiras e colunas), a
 * situação de cada cadeira e a seleção do comprador.
 *
 * Cada cadeira tem o próprio signal. Uma mudança que chega por SSE toca só as
 * cadeiras citadas: o mapa não é redesenhado, e o Angular atualiza apenas os
 * atributos que mudaram.
 */
export class SeatMapState {
  readonly rows: RowView[];
  /** Largura do desenho, em cadeiras (a fileira mais longa). */
  readonly columns: number;

  private readonly seats = new Map<
    string,
    { view: SeatView; available: WritableSignal<boolean | null> }
  >();
  private readonly selection = signal<readonly string[]>([]);
  private readonly ready = signal(false);

  /** Cadeiras escolhidas, na ordem do mapa. */
  readonly selected = computed(() =>
    [...this.selection()].sort((a, b) => this.order(a) - this.order(b)),
  );
  readonly count = computed(() => this.selection().length);
  readonly full = computed(() => this.count() >= this.max);
  /** A foto do setor já chegou. */
  readonly loaded = this.ready.asReadonly();

  constructor(
    rows: readonly SeatRow[],
    readonly max = MAX_SEATS,
  ) {
    this.columns = Math.max(0, ...rows.map((row) => row.seatCount));
    this.rows = rows.map((row, rowIndex) => {
      const offset = (this.columns - row.seatCount) / 2;
      const seats = Array.from({ length: row.seatCount }, (_, index): SeatView => {
        const available = signal<boolean | null>(null);
        const view: SeatView = {
          label: `${row.label}-${index + 1}`,
          row: row.label,
          number: index + 1,
          rowIndex,
          index,
          column: offset + index,
          available: available.asReadonly(),
        };
        this.seats.set(view.label, { view, available });
        return view;
      });
      return { label: row.label, index: rowIndex, seats };
    });
  }

  seat(label: string): SeatView | undefined {
    return this.seats.get(label)?.view;
  }

  isSelected(label: string): boolean {
    return this.selection().includes(label);
  }

  /** Escolhe ou devolve uma cadeira, respeitando o limite e a disponibilidade. */
  toggle(label: string): ToggleResult {
    const entry = this.seats.get(label);
    if (!entry) {
      return 'unknown';
    }
    if (this.isSelected(label)) {
      this.selection.update((current) => current.filter((item) => item !== label));
      return 'deselected';
    }
    if (entry.available() !== true) {
      return 'unavailable';
    }
    if (this.full()) {
      return 'limit';
    }
    this.selection.update((current) => [...current, label]);
    return 'selected';
  }

  /**
   * Aplica a foto do setor inteiro (a primeira, ou a de uma reconexão).
   * Devolve as cadeiras escolhidas que deixaram de estar livres.
   */
  applySnapshot(statuses: readonly SeatStatus[]): string[] {
    for (const status of statuses) {
      this.seats.get(status.label)?.available.set(status.available);
    }
    this.ready.set(true);
    return this.dropUnavailable();
  }

  /** Aplica uma mudança ao vivo. Devolve as cadeiras escolhidas que outra pessoa pegou. */
  applyChange(change: SeatChange): string[] {
    for (const label of change.seats) {
      this.seats.get(label)?.available.set(change.available);
    }
    return change.available ? [] : this.dropUnavailable();
  }

  /** Marca cadeiras como ocupadas (a API respondeu que alguém as pegou). */
  markUnavailable(labels: readonly string[]): string[] {
    return this.applyChange({ sectorId: '', seats: [...labels], available: false });
  }

  clear(): void {
    this.selection.set([]);
  }

  /** A cadeira vizinha para a navegação pelo teclado. */
  neighbor(label: string, direction: Direction): string | undefined {
    const seat = this.seat(label);
    if (!seat) {
      return undefined;
    }
    const row = this.rows[seat.rowIndex].seats;
    switch (direction) {
      case 'left':
        return row[seat.index - 1]?.label;
      case 'right':
        return row[seat.index + 1]?.label;
      case 'home':
        return row[0]?.label;
      case 'end':
        return row[row.length - 1]?.label;
      case 'up':
      case 'down': {
        // A cadeira mais próxima na fileira de cima (ou de baixo), pelo desenho.
        const step = direction === 'up' ? -1 : 1;
        for (
          let index = seat.rowIndex + step;
          index >= 0 && index < this.rows.length;
          index += step
        ) {
          const target = this.rows[index].seats;
          if (target.length > 0) {
            return target.reduce((best, candidate) =>
              Math.abs(candidate.column - seat.column) < Math.abs(best.column - seat.column)
                ? candidate
                : best,
            ).label;
          }
        }
        return undefined;
      }
    }
  }

  private order(label: string): number {
    const seat = this.seat(label);
    return seat ? seat.rowIndex * 10_000 + seat.index : Number.MAX_SAFE_INTEGER;
  }

  private dropUnavailable(): string[] {
    const lost = this.selection().filter((label) => this.seats.get(label)?.available() === false);
    if (lost.length > 0) {
      this.selection.update((current) => current.filter((label) => !lost.includes(label)));
    }
    return lost;
  }
}
