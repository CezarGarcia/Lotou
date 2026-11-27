import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCloudOff, lucideDoorOpen, lucideRotateCw, lucideScanLine } from '@ng-icons/lucide';
import { Observable, catchError, from, map, of, startWith, switchMap } from 'rxjs';
import { ShowDatePipe, formatInTimezone } from '../core/format/show-date.pipe';
import { ApiError, toApiError } from '../core/http/problem';
import { Cartaz } from '../shared/ui/cartaz';
import { CheckinApi, CheckinShow } from './data/checkin.api';
import { GATE_MAX_LENGTH, GateSettings, normalizeGate } from './gate-settings';
import { GATE_OFFLINE_DB } from './offline/gate-offline-db';
import { GateSector, sectorsOf } from './offline/offline-package';

type ShowsState =
  | { status: 'loading' }
  /** `stored`: sem o servidor, os shows com a lista guardada no aparelho. */
  | { status: 'ready'; shows: CheckinShow[]; stored?: boolean }
  | { status: 'error'; error: ApiError };

/** Sugestões para o campo do portão; o nome é livre. */
const GATE_SUGGESTIONS = ['Portão A', 'Portão B', 'Portão C', 'Acesso PCD', 'Camarote'];

/**
 * Início da portaria: o show (de hoje e dos próximos dias), o portão em que
 * a pessoa está e, se o portão atende só alguns setores, quais. O portão e os
 * setores ficam guardados no aparelho para o próximo turno.
 *
 * Sem o servidor, a lista mostra os shows que o aparelho já tem guardados
 * para validar sem internet (ADR 38).
 */
@Component({
  selector: 'app-gate-setup-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, NgIcon, Cartaz, ShowDatePipe],
  viewProviders: [provideIcons({ lucideCloudOff, lucideDoorOpen, lucideRotateCw, lucideScanLine })],
  templateUrl: './gate-setup.page.html',
  styleUrl: './gate-setup.page.scss',
})
export class GateSetupPage {
  private readonly api = inject(CheckinApi);
  private readonly settings = inject(GateSettings);
  private readonly router = inject(Router);
  private readonly db = inject(GATE_OFFLINE_DB);

  /** `?show=`: o show que já vem escolhido (de volta do leitor). */
  readonly show = input<string>();

  protected readonly maxLength = GATE_MAX_LENGTH;
  protected readonly suggestions = GATE_SUGGESTIONS;
  protected readonly form = new FormGroup({
    show: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    gate: new FormControl(this.settings.gate(), {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/\S/)],
    }),
  });

  private readonly attempt = signal(0);
  protected readonly shows = toSignal(
    toObservable(this.attempt).pipe(
      switchMap(() =>
        this.api.shows().pipe(
          map((shows): ShowsState => ({ status: 'ready', shows })),
          catchError((error: unknown) => this.storedShows(toApiError(error))),
          startWith<ShowsState>({ status: 'loading' }),
        ),
      ),
    ),
    { initialValue: { status: 'loading' } as ShowsState },
  );

  protected readonly list = computed(() => {
    const state = this.shows();
    return state.status === 'ready' ? state.shows : [];
  });
  /** Os shows de hoje (no fuso de cada show) ganham a etiqueta "Hoje". */
  protected readonly today = computed(() => {
    const now = new Date();
    return new Set(
      this.list()
        .filter(
          (show) =>
            formatInTimezone(show.startsAt, show.timezone, 'date') ===
            formatInTimezone(now, show.timezone, 'date'),
        )
        .map((show) => show.showId),
    );
  });
  protected readonly gateValue = toSignal(this.form.controls.gate.valueChanges, {
    initialValue: this.form.controls.gate.value,
  });
  protected readonly stored = computed(() => {
    const state = this.shows();
    return state.status === 'ready' && state.stored === true;
  });

  private readonly showValue = toSignal(this.form.controls.show.valueChanges, {
    initialValue: this.form.controls.show.value,
  });
  /** Os setores do show escolhido: do catálogo ou, sem internet, do pacote guardado. */
  protected readonly sectors = toSignal(
    toObservable(this.showValue).pipe(
      switchMap((showId) =>
        showId
          ? this.api.sectors(showId).pipe(
              catchError(() =>
                from(this.db.loadPackage(showId).catch(() => null)).pipe(
                  map((stored) => sectorsOf(stored?.pkg ?? null)),
                ),
              ),
              startWith<GateSector[]>([]),
            )
          : of<GateSector[]>([]),
      ),
    ),
    { initialValue: [] as GateSector[] },
  );
  /**
   * Os setores escolhidos para este portão; vazio, todos. Começa com os que
   * este aparelho atendia no show, se ainda existem.
   */
  protected readonly chosen = linkedSignal(() => {
    const known = new Set(this.sectors().map((sector) => sector.id));
    return this.settings.sectorsFor(this.showValue()).filter((id) => known.has(id));
  });
  protected readonly errorMessage = computed(() => {
    const state = this.shows();
    return state.status === 'error' ? state.error.message : '';
  });

  constructor() {
    // O show que veio na URL ou, se houver um só, ele mesmo.
    effect(() => {
      const list = this.list();
      const wanted = this.show();
      const control = this.form.controls.show;
      if (control.value) {
        return;
      }
      if (wanted && list.some((show) => show.showId === wanted)) {
        control.setValue(wanted);
      } else if (list.length === 1) {
        control.setValue(list[0].showId);
      }
    });
  }

  /** Liga e desliga um setor; sem nenhum, o portão atende todos. */
  protected toggleSector(id: string): void {
    this.chosen.update((ids) =>
      ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
    );
  }

  protected allSectors(): void {
    this.chosen.set([]);
  }

  private storedShows(error: ApiError): Observable<ShowsState> {
    return from(this.db.storedShows().catch(() => [])).pipe(
      map((shows): ShowsState =>
        shows.length > 0 ? { status: 'ready', shows, stored: true } : { status: 'error', error },
      ),
    );
  }

  /** Toque numa sugestão: preenche o portão. */
  protected pickGate(name: string): void {
    this.form.controls.gate.setValue(name);
    this.form.controls.gate.markAsDirty();
  }

  protected reload(): void {
    this.attempt.update((value) => value + 1);
  }

  protected begin(): void {
    const { show, gate } = this.form.getRawValue();
    const name = normalizeGate(gate);
    if (!show || !name) {
      this.form.markAllAsTouched();
      return;
    }
    this.settings.setGate(name);
    const sectors = this.chosen();
    this.settings.setSectors(show, sectors);
    void this.router.navigate(['/portaria/shows', show], {
      queryParams:
        sectors.length > 0 ? { portao: name, setores: sectors.join(',') } : { portao: name },
    });
  }
}
