import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowRight, lucideInfo, lucideUsers } from '@ng-icons/lucide';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { SectorAvailability } from '../data/sale.models';
import { SectorKind, Show } from '../data/show.models';
import { AvailabilityState } from '../shared/live-availability';
import { SaleChip } from '../shared/sale-chip';
import { SalesCountdown } from './sales-countdown';

export const KIND_LABELS: Record<SectorKind, string> = {
  GENERAL_ADMISSION: 'Sem lugar marcado',
  RESERVED_SEATING: 'Lugar marcado',
};

/** A sala de espera da fila virtual abre 30 minutos antes das vendas. */
const WAITING_ROOM_LEAD_MS = 30 * 60_000;

interface SectorOption {
  id: string;
  name: string;
  kind: SectorKind;
  live: SectorAvailability | undefined;
  /** Dá para seguir com este setor agora. */
  selectable: boolean;
}

/**
 * Painel de compra da página do show: preço, contagem regressiva, a escolha do
 * setor e o botão que leva ao checkout (ou à fila, em show de alta demanda).
 *
 * No desktop, o painel acompanha a rolagem ao lado da página. No celular, o
 * preço e o botão ficam numa barra presa embaixo da tela; antes de escolher o
 * setor, a barra oferece "Escolher setor", que leva à lista de setores.
 */
@Component({
  selector: 'app-buy-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, MoneyPipe, ShowDatePipe, SaleChip, SalesCountdown],
  viewProviders: [provideIcons({ lucideArrowRight, lucideInfo, lucideUsers })],
  templateUrl: './buy-panel.html',
  styleUrl: './buy-panel.scss',
})
export class BuyPanel {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly show = input.required<Show>();
  readonly availability = input.required<AvailabilityState>();

  protected readonly selected = signal<string | null>(null);
  protected readonly tz = computed(() => this.show().venue?.timezone);

  protected readonly options = computed((): SectorOption[] => {
    const { sectors, highDemand, status } = this.show();
    const live = new Map((this.availability().value?.sectors ?? []).map((s) => [s.id, s]));
    return sectors.map((sector) => {
      const current = live.get(sector.id);
      // Na alta demanda, dá para escolher o setor e entrar na sala de espera antes da abertura.
      const selectable =
        status !== 'CANCELLED' &&
        (current?.sale === 'ON_SALE' || (highDemand && current?.sale === 'NOT_OPEN'));
      return { id: sector.id, name: sector.name, kind: sector.kind, live: current, selectable };
    });
  });

  /** Algum setor pode ser escolhido agora. */
  protected readonly selectable = computed(() =>
    this.options().some((option) => option.selectable),
  );

  protected readonly choice = computed(() =>
    this.options().find((option) => option.id === this.selected() && option.selectable),
  );

  /** Menor preço à venda agora; antes da primeira consulta, o do documento do show. */
  protected readonly fromCents = computed(() => {
    const prices = this.options()
      .filter((option) => option.live?.sale === 'ON_SALE' && option.live.lot)
      .map((option) => option.live!.lot!.priceCents);
    return prices.length > 0 ? Math.min(...prices) : this.show().priceFromCents;
  });

  protected readonly waitingRoomOpensAt = computed(() => {
    const salesStartAt = this.show().salesStartAt;
    return salesStartAt
      ? new Date(new Date(salesStartAt).getTime() - WAITING_ROOM_LEAD_MS).toISOString()
      : null;
  });

  /** Logado, mas sem o papel de comprador (produtor ou portaria). */
  protected readonly notBuyer = computed(
    () => this.auth.authenticated() && this.auth.roles().length > 0 && !this.auth.hasRole('buyer'),
  );

  protected readonly canContinue = computed(() => !!this.choice() && !this.notBuyer());

  protected readonly hint = computed(() => {
    const options = this.options();
    const { value, loaded, error } = this.availability();
    const states = options.map((option) => option.live?.sale);
    if (this.show().status === 'CANCELLED') {
      return 'Este show foi cancelado.';
    }
    if (!value) {
      return loaded && error
        ? 'Não foi possível consultar os ingressos agora. Tentando de novo...'
        : 'Consultando os ingressos disponíveis...';
    }
    if (states.every((state) => state === 'CLOSED')) {
      return 'As vendas deste show foram encerradas.';
    }
    if (states.every((state) => state === 'SOLD_OUT' || state === 'CLOSED')) {
      return 'Ingressos esgotados.';
    }
    if (!options.some((option) => option.selectable)) {
      return states.includes('PAUSED')
        ? 'As vendas estão pausadas no momento.'
        : 'As vendas ainda não abriram.';
    }
    if (this.notBuyer()) {
      return 'Sua conta não é de comprador. Entre com uma conta de comprador para comprar.';
    }
    if (!this.choice()) {
      return 'Escolha um setor para continuar.';
    }
    if (this.show().highDemand) {
      return 'Você vai para a fila virtual. Quando chegar a sua vez, terá 5 minutos para reservar.';
    }
    return this.auth.authenticated()
      ? 'Você escolhe a quantidade (ou as cadeiras) na próxima tela.'
      : 'Você vai entrar na sua conta antes de escolher os ingressos.';
  });

  protected readonly kindLabels = KIND_LABELS;

  protected continue(): void {
    const choice = this.choice();
    if (!choice || !this.canContinue()) {
      return;
    }
    const id = this.show().id;
    void (this.show().highDemand
      ? this.router.navigate(['/shows', id, 'fila'], { queryParams: { setor: choice.id } })
      : this.router.navigate(['/shows', id, 'comprar', choice.id]));
  }

  /** Leva à escolha do setor (a barra do celular, antes da escolha). */
  protected showPicker(): void {
    const element = this.host.nativeElement;
    const target = element.querySelector<HTMLElement>('.picker') ?? element;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    element.querySelector<HTMLInputElement>('.picker input:not(:disabled)')?.focus({
      preventScroll: true,
    });
  }
}
