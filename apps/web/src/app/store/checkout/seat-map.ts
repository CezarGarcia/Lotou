import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Direction, SeatMapState, SeatView } from './seat-map.state';

/** Distância entre centros de cadeiras, em unidades do SVG. */
const PITCH = 28;
const RADIUS = 11;
/** Espaço para o nome da fileira, dos dois lados. */
const GUTTER = 28;
/** Espaço do palco, acima da primeira fileira. */
const STAGE = 52;
/** Tamanho máximo de uma cadeira na tela, em px, sem zoom: setores pequenos não viram bolas gigantes. */
const MAX_SEAT_PX = 40;
/** Tamanho mínimo de uma cadeira, em px: no celular, o mapa rola para o lado em vez de encolher demais. */
const MIN_SEAT_PX = 16;
const ZOOM_STEPS = [1, 1.5, 2, 3];

const KEYS: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
};

/**
 * Mapa de cadeiras em SVG, desenhado a partir das fileiras do local. Cada
 * cadeira tem a cor da situação dela, e as mudanças ao vivo trocam só a classe
 * das cadeiras afetadas.
 *
 * Acessível pelo teclado como uma grade (padrão ARIA "grid"): Tab entra no
 * mapa, as setas andam entre as cadeiras, Home e End vão ao começo e ao fim da
 * fileira, e Enter ou Espaço escolhe.
 */
@Component({
  selector: 'app-seat-map',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule],
  templateUrl: './seat-map.html',
  styleUrl: './seat-map.scss',
})
export class SeatMap {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');

  readonly state = input.required<SeatMapState>();
  readonly sectorName = input('');
  /** Clique ou Enter numa cadeira. Quem decide se ela entra na seleção é o checkout. */
  readonly toggled = output<string>();

  protected readonly pitch = PITCH;
  protected readonly radius = RADIUS;
  protected readonly gutter = GUTTER;
  protected readonly stage = STAGE;

  protected readonly zoom = signal(0);
  protected readonly scale = computed(() => ZOOM_STEPS[this.zoom()]);
  protected readonly canZoomIn = computed(() => this.zoom() < ZOOM_STEPS.length - 1);

  protected readonly width = computed(() => GUTTER * 2 + this.state().columns * PITCH);
  protected readonly height = computed(() => STAGE + this.state().rows.length * PITCH + 4);
  protected readonly viewBox = computed(() => `0 0 ${this.width()} ${this.height()}`);
  protected readonly maxWidth = computed(() => (this.width() / PITCH) * MAX_SEAT_PX * this.scale());
  protected readonly minWidth = computed(() => (this.width() / PITCH) * MIN_SEAT_PX * this.scale());

  /** A cadeira que recebe o foco do Tab (tabindex itinerante). */
  protected readonly focused = signal<string | null>(null);
  protected readonly tabStop = computed(
    () => this.focused() ?? this.state().rows.find((row) => row.seats.length > 0)?.seats[0].label,
  );

  protected x(seat: SeatView): number {
    return GUTTER + seat.column * PITCH + PITCH / 2;
  }

  protected y(rowIndex: number): number {
    return STAGE + rowIndex * PITCH + PITCH / 2;
  }

  protected label(seat: SeatView): string {
    const available = seat.available();
    const status = available === null ? 'carregando' : available ? 'livre' : 'ocupada';
    return `Fileira ${seat.row}, cadeira ${seat.number}, ${status}`;
  }

  constructor() {
    // Mapa maior que a tela (celular): começa no centro, de frente para o palco.
    afterNextRender(() => this.keepCenter(0.5, 0));
  }

  /** Aproxima ou afasta mantendo no centro o ponto que estava no centro. */
  protected zoomBy(step: number): void {
    const element = this.viewport().nativeElement;
    const x = (element.scrollLeft + element.clientWidth / 2) / (element.scrollWidth || 1);
    const y = (element.scrollTop + element.clientHeight / 2) / (element.scrollHeight || 1);
    this.zoom.update((value) => Math.min(ZOOM_STEPS.length - 1, Math.max(0, value + step)));
    afterNextRender(() => this.keepCenter(x, y), { injector: this.injector });
  }

  private keepCenter(x: number, y: number): void {
    const element = this.viewport().nativeElement;
    element.scrollLeft = x * element.scrollWidth - element.clientWidth / 2;
    element.scrollTop = y * element.scrollHeight - element.clientHeight / 2;
  }

  protected choose(label: string): void {
    this.focused.set(label);
    this.toggled.emit(label);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const current = this.tabStop();
    if (!current) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.choose(current);
      return;
    }
    const direction = KEYS[event.key];
    const next = direction && this.state().neighbor(current, direction);
    if (direction) {
      event.preventDefault();
    }
    if (next) {
      this.focused.set(next);
      this.host.nativeElement.querySelector<SVGGElement>(`[data-seat="${next}"]`)?.focus();
    }
  }
}
