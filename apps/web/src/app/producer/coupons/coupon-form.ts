import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { utcToZonedLocal } from '../../core/format/zoned-time';
import { Sector } from '../../store/data/show.models';
import { CouponKind, CreateCoupon } from '../data/coupons.api';
import {
  CouponFormValue,
  MAX_COUPON_USES,
  brlAmountValidator,
  couponCodeValidator,
  futureInTimezone,
  normalizeCode,
  toCreateCoupon,
} from './coupon-form.model';

/**
 * Formulário de um cupom novo: código, percentual ou valor fixo em reais,
 * limite de usos, validade (no fuso do show) e, se quiser, os setores.
 */
@Component({
  selector: 'app-coupon-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatRadioModule,
  ],
  templateUrl: './coupon-form.html',
  styleUrl: './coupon-form.scss',
})
export class CouponForm {
  readonly showId = input.required<string>();
  /** Fuso do show: a validade digitada é horário de lá. */
  readonly timezone = input<string>();
  readonly sectors = input<readonly Sector[]>([]);
  /** Valor inicial da validade (UTC): o início do show. */
  readonly defaultValidUntil = input<string>();
  readonly pending = input(false);
  /** Erro do servidor no código (já existe). */
  readonly codeError = input<string | null>(null);

  readonly save = output<CreateCoupon>();
  readonly cancel = output<void>();

  protected readonly form = new FormGroup({
    code: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, couponCodeValidator],
    }),
    kind: new FormControl<CouponKind>('PERCENT', { nonNullable: true }),
    percent: new FormControl<number | null>(10, [
      Validators.required,
      Validators.min(1),
      Validators.max(100),
      Validators.pattern(/^\d+$/),
    ]),
    amount: new FormControl(
      { value: '', disabled: true },
      { nonNullable: true, validators: [Validators.required, brlAmountValidator] },
    ),
    maxUses: new FormControl<number | null>(100, [
      Validators.required,
      Validators.min(1),
      Validators.max(MAX_COUPON_USES),
      Validators.pattern(/^\d+$/),
    ]),
    validUntil: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, futureInTimezone(() => this.timezone())],
    }),
    sectorIds: new FormControl<string[]>([], { nonNullable: true }),
  });

  protected readonly kind = toSignal(this.form.controls.kind.valueChanges, {
    initialValue: this.form.controls.kind.value,
  });
  private readonly selected = toSignal(this.form.controls.sectorIds.valueChanges, {
    initialValue: [] as string[],
  });
  protected readonly selectedSectors = computed(() => new Set(this.selected()));

  /** "Horário de Recife" a partir do fuso IANA, para o campo de validade. */
  protected readonly zoneLabel = computed(() => {
    const zone = this.timezone();
    return zone ? `Horário do local do show (${zone.split('/').pop()!.replace(/_/g, ' ')})` : '';
  });

  constructor() {
    // Percentual ou valor fixo: só o campo do tipo escolhido é obrigatório.
    effect(() => {
      const kind = this.kind();
      const { percent, amount } = this.form.controls;
      if (kind === 'PERCENT') {
        percent.enable({ emitEvent: false });
        amount.disable({ emitEvent: false });
      } else {
        amount.enable({ emitEvent: false });
        percent.disable({ emitEvent: false });
      }
    });

    effect(() => {
      const start = this.defaultValidUntil();
      const zone = this.timezone();
      const control = this.form.controls.validUntil;
      if (start && zone && untracked(() => control.value === '')) {
        control.setValue(utcToZonedLocal(start, zone));
      }
    });

    effect(() => {
      const message = this.codeError();
      if (message) {
        this.form.controls.code.setErrors({ taken: message });
        this.form.controls.code.markAsTouched();
      }
    });
  }

  protected uppercase(): void {
    const control = this.form.controls.code;
    const value = normalizeCode(control.value);
    if (value !== control.value) {
      control.setValue(value);
    }
  }

  protected toggleSector(id: string, checked: boolean): void {
    const control = this.form.controls.sectorIds;
    const current = control.value.filter((item) => item !== id);
    control.setValue(checked ? [...current, id] : current);
  }

  protected submit(): void {
    if (this.form.invalid || this.pending()) {
      this.form.markAllAsTouched();
      return;
    }
    const raw = this.form.getRawValue() as CouponFormValue;
    const body = toCreateCoupon(raw, this.showId(), this.timezone());
    if (body) {
      this.save.emit(body);
    }
  }

  /** Volta ao formulário em branco (depois de criar). */
  reset(): void {
    const validUntil = this.form.controls.validUntil.value;
    this.form.reset({
      code: '',
      kind: 'PERCENT',
      percent: 10,
      amount: '',
      maxUses: 100,
      validUntil,
      sectorIds: [],
    });
  }
}
