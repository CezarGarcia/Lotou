import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCloudOff,
  lucidePause,
  lucidePlay,
  lucidePlus,
  lucideTicketPercent,
} from '@ng-icons/lucide';
import { CountPipe, formatCount } from '../../core/format/count.pipe';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { listPt } from '../../store/shared/purchase-errors';
import { Coupon, CreateCoupon } from '../data/coupons.api';
import { ProducerShowContext } from '../show/show-context';
import { CouponForm } from './coupon-form';
import { COUPON_STATUS_LABELS, describeDiscount } from './coupon-form.model';
import { CouponsStore } from './coupons.store';

/** Cupons de um show: a lista com usos e desconto dado, a criação e pausar/retomar. */
@Component({
  selector: 'app-coupons-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, NgIcon, CountPipe, MoneyPipe, ShowDatePipe, CouponForm],
  viewProviders: [
    provideIcons({ lucideCloudOff, lucidePause, lucidePlay, lucidePlus, lucideTicketPercent }),
  ],
  providers: [CouponsStore],
  templateUrl: './coupons.page.html',
  styleUrl: './coupons.page.scss',
})
export class CouponsPage {
  protected readonly store = inject(CouponsStore);
  protected readonly context = inject(ProducerShowContext);
  private readonly snackBar = inject(MatSnackBar);
  private readonly form = viewChild(CouponForm);

  protected readonly formOpen = signal(false);
  protected readonly createError = signal<{ message: string; traceId?: string } | null>(null);
  protected readonly codeError = signal<string | null>(null);

  protected readonly describe = describeDiscount;
  protected readonly skeletons = [1, 2];

  private readonly sectorNames = computed(
    () => new Map(this.context.sectors().map((sector) => [sector.id, sector.name])),
  );

  constructor() {
    effect(() => {
      const id = this.context.id();
      if (id) {
        this.store.load(id);
      }
    });
  }

  protected status(coupon: Coupon): string {
    return COUPON_STATUS_LABELS[coupon.status] ?? coupon.status;
  }

  /** "Todos os setores" ou "Pista e Camarote". */
  protected sectorsText(coupon: Coupon): string {
    if (!coupon.sectorIds?.length) {
      return 'Todos os setores';
    }
    const names = coupon.sectorIds.map((id) => this.sectorNames().get(id) ?? 'setor removido');
    return `Só ${listPt(names)}`;
  }

  protected usedPercent(coupon: Coupon): number {
    return coupon.maxUses > 0 ? Math.min(100, Math.round((coupon.uses / coupon.maxUses) * 100)) : 0;
  }

  protected usesText(coupon: Coupon): string {
    return `${formatCount(coupon.uses)} de ${formatCount(coupon.maxUses)} usos (${this.usedPercent(coupon)}%)`;
  }

  protected openForm(): void {
    this.createError.set(null);
    this.codeError.set(null);
    this.formOpen.set(true);
  }

  protected create(body: CreateCoupon): void {
    this.createError.set(null);
    this.codeError.set(null);
    this.store.create(body).subscribe((outcome) => {
      if (outcome.ok) {
        this.form()?.reset();
        this.formOpen.set(false);
        this.snackBar.open(`Cupom ${outcome.coupon.code} criado.`, 'OK', { duration: 5_000 });
        return;
      }
      if (outcome.field === 'code') {
        this.codeError.set(outcome.message);
        return;
      }
      this.createError.set({ message: outcome.message, traceId: outcome.traceId });
    });
  }
}
