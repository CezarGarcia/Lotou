import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideDoorOpen, lucideRotateCw, lucideScanLine } from '@ng-icons/lucide';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import { ShowDatePipe, formatInTimezone } from '../core/format/show-date.pipe';
import { ApiError, toApiError } from '../core/http/problem';
import { Cartaz } from '../shared/ui/cartaz';
import { CheckinApi, CheckinShow } from './data/checkin.api';
import { GATE_MAX_LENGTH, GateSettings, normalizeGate } from './gate-settings';

type ShowsState =
  | { status: 'loading' }
  | { status: 'ready'; shows: CheckinShow[] }
  | { status: 'error'; error: ApiError };

/** Sugestões para o campo do portão; o nome é livre. */
const GATE_SUGGESTIONS = ['Portão A', 'Portão B', 'Portão C', 'Acesso PCD', 'Camarote'];

/**
 * Início da portaria: o show (de hoje e dos próximos dias) e o portão em que
 * a pessoa está. O portão fica guardado no aparelho para o próximo turno.
 */
@Component({
  selector: 'app-gate-setup-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, NgIcon, Cartaz, ShowDatePipe],
  viewProviders: [provideIcons({ lucideDoorOpen, lucideRotateCw, lucideScanLine })],
  templateUrl: './gate-setup.page.html',
  styleUrl: './gate-setup.page.scss',
})
export class GateSetupPage {
  private readonly api = inject(CheckinApi);
  private readonly settings = inject(GateSettings);
  private readonly router = inject(Router);

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
          catchError((error: unknown) =>
            of<ShowsState>({ status: 'error', error: toApiError(error) }),
          ),
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
    void this.router.navigate(['/portaria/shows', show], { queryParams: { portao: name } });
  }
}
