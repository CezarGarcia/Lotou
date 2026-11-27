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
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Router } from '@angular/router';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import { ShowDatePipe } from '../core/format/show-date.pipe';
import { ApiError, toApiError } from '../core/http/problem';
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
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    ShowDatePipe,
  ],
  template: `
    <div class="container page">
      <header>
        <p class="eyebrow">Portaria</p>
        <h1>Onde você está?</h1>
        <p>Escolha o show e o portão. Cada leitura fica registrada com esse portão.</p>
      </header>

      <form [formGroup]="form" (ngSubmit)="begin()">
        <fieldset aria-describedby="shows-help">
          <legend>Show</legend>
          <p id="shows-help" class="help">Shows de hoje e dos próximos dias.</p>
          @switch (shows().status) {
            @case ('loading') {
              <div class="state" aria-busy="true">
                <mat-spinner diameter="32" aria-label="Carregando os shows" />
              </div>
            }
            @case ('error') {
              <div class="state" role="alert">
                <p>Não foi possível carregar os shows. {{ errorMessage() }}</p>
                <button matButton="tonal" type="button" (click)="reload()">Tentar de novo</button>
              </div>
            }
            @default {
              @if (list().length === 0) {
                <p class="state">Nenhum show hoje nem nos próximos dias.</p>
              }
              <div class="shows" role="radiogroup" aria-label="Show">
                @for (show of list(); track show.showId) {
                  <label class="show" [class.checked]="form.controls.show.value === show.showId">
                    <input type="radio" [value]="show.showId" formControlName="show" />
                    <span class="text">
                      <strong>{{ show.artist }}</strong>
                      <span>{{ show.title }}</span>
                      <span class="meta">
                        {{ show.startsAt | showDate: show.timezone : 'short' }} ·
                        {{ show.venueName }}
                      </span>
                      @if (show.doorsOpenAt) {
                        <span class="meta"
                          >Portões abrem às
                          {{ show.doorsOpenAt | showDate: show.timezone : 'time' }}</span
                        >
                      }
                    </span>
                  </label>
                }
              </div>
            }
          }
        </fieldset>

        <mat-form-field appearance="outline">
          <mat-label>Portão</mat-label>
          <input
            matInput
            formControlName="gate"
            autocomplete="off"
            [attr.maxlength]="maxLength"
            list="gate-suggestions"
          />
          <datalist id="gate-suggestions">
            @for (suggestion of suggestions; track suggestion) {
              <option [value]="suggestion"></option>
            }
          </datalist>
          <mat-hint>Como está escrito na placa: "Portão B", "Acesso PCD".</mat-hint>
          @if (form.controls.gate.hasError('required')) {
            <mat-error>Informe o portão.</mat-error>
          }
        </mat-form-field>

        <button matButton="filled" type="submit" class="cta" [disabled]="form.invalid">
          <mat-icon aria-hidden="true">qr_code_scanner</mat-icon>
          Começar a leitura
        </button>
      </form>
    </div>
  `,
  styles: `
    .page {
      display: grid;
      gap: 20px;
      max-width: 560px;
      padding-block: 24px 64px;
    }
    header p {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
    .eyebrow {
      font: var(--mat-sys-label-large);
      font-weight: 600;
      color: var(--mat-sys-primary) !important;
    }
    h1 {
      margin: 4px 0;
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    form {
      display: grid;
      gap: 20px;
    }
    fieldset {
      margin: 0;
      padding: 0;
      border: 0;
    }
    legend {
      font: var(--mat-sys-title-medium);
      font-weight: 700;
    }
    .help {
      margin: 0 0 8px;
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
    }
    .shows {
      display: grid;
      gap: 8px;
    }
    .show {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      min-height: 56px;
      padding: 14px 16px;
      border: 2px solid var(--mat-sys-outline-variant);
      border-radius: 16px;
      cursor: pointer;
    }
    .show.checked {
      border-color: var(--mat-sys-primary);
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    .show:has(input:focus-visible) {
      outline: 3px solid var(--mat-sys-primary);
      outline-offset: 2px;
    }
    input[type='radio'] {
      width: 22px;
      height: 22px;
      margin: 2px 0 0;
      accent-color: var(--mat-sys-primary);
    }
    .text {
      display: grid;
    }
    .meta {
      font: var(--mat-sys-body-small);
      opacity: 0.85;
    }
    .state {
      display: grid;
      justify-items: center;
      gap: 8px;
      padding: 16px;
      color: var(--mat-sys-on-surface-variant);
      text-align: center;
    }
    .cta {
      height: 56px;
    }
  `,
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
