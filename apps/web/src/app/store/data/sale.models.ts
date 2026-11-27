/** Contrato da disponibilidade, da fila virtual, das reservas e dos pedidos (via gateway). */

import { SectorKind } from './show.models';

/** Situação das vendas de um setor, segundo o lote em venda. */
export type SaleState = 'NOT_OPEN' | 'ON_SALE' | 'PAUSED' | 'SOLD_OUT' | 'CLOSED';

/** O lote em venda: é ele que define o preço. */
export interface CurrentLot {
  id: string;
  name: string;
  priceCents: number;
}

export interface SectorAvailability {
  id: string;
  name: string;
  kind: SectorKind;
  capacity: number;
  sale: SaleState;
  lot: CurrentLot | null;
  /** Ingressos que ainda podem ser reservados no lote em venda. */
  available: number;
}

/** O que está à venda agora. Nunca vem de cache: preço e estoque são os do inventory. */
export interface ShowAvailability {
  showId: string;
  sectors: SectorAvailability[];
}

export interface SeatStatus {
  /** `{fileira}-{n}`, como `A-12`. */
  label: string;
  available: boolean;
}

export interface SectorSeats {
  showId: string;
  sectorId: string;
  /** Na ordem do mapa. */
  seats: SeatStatus[];
}

/** Mudança no mapa que chega por SSE: cadeiras que alguém segurou ou que voltaram à venda. */
export interface SeatChange {
  sectorId: string;
  seats: string[];
  available: boolean;
}

/** O que o fluxo de cadeiras entrega: a foto do setor inteiro ou uma mudança. */
export type SeatFeedEvent =
  { type: 'snapshot'; seats: SeatStatus[] } | { type: 'change'; change: SeatChange };

export type QueueState =
  'NOT_REQUIRED' | 'NOT_OPEN' | 'WAITING_ROOM' | 'QUEUED' | 'ADMITTED' | 'NOT_IN_QUEUE' | 'CLOSED';

/** Situação do comprador na fila virtual de um show de alta demanda. */
export interface QueueStatus {
  showId: string;
  status: QueueState;
  /** 1 é o próximo. */
  position?: number;
  estimatedWaitSeconds?: number;
  /** Até quando vale a admissão (5 minutos). */
  admittedUntil?: string;
  salesStartAt?: string;
  waitingRoomOpensAt?: string;
}

export type ReservationStatus = 'HELD' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED';

export interface ReservationItem {
  lotId: string;
  lotName: string;
  seat: string | null;
  unitPriceCents: number;
}

export interface Reservation {
  id: string;
  status: ReservationStatus;
  showId: string;
  sectorId: string;
  sectorName: string;
  quantity: number;
  totalCents: number;
  /** Fim do prazo para pagar (10 minutos). */
  expiresAt: string;
  createdAt: string;
  items: ReservationItem[];
}

/** Pista: quantidade. Cadeira numerada: as cadeiras (até 4, tudo ou nada). */
export type CreateReservation = { showId: string; sectorId: string; cpf: string } & (
  { quantity: number } | { seats: string[] }
);

export type OrderStatus =
  'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'REFUNDING' | 'REFUNDED' | 'REFUND_FAILED';

export type CancelReason = 'PAYMENT_DECLINED' | 'RESERVATION_EXPIRED' | 'TICKET_CONFLICT';

export type TicketStatus = 'VALID' | 'USED' | 'CANCELLED';

export interface OrderItem {
  sectorName: string;
  lotName: string;
  seat: string | null;
  unitPriceCents: number;
}

export interface Ticket {
  id: string;
  status: TicketStatus;
  sectorName: string;
  seat: string | null;
  issuedAt: string;
  /** Entrada na portaria (só em `USED`): quando e por qual portão. */
  usedAt?: string | null;
  gate?: string | null;
  /**
   * Conteúdo do QR code: `LOTOU1.<ticketId>.<assinatura HMAC>`, conferido na
   * portaria. Ausente nos ingressos emitidos antes do código assinado.
   */
  code?: string | null;
}

/** Quem paga a taxa de serviço de 10%: o comprador (somada ao total) ou o produtor. */
export type ServiceFeePayer = 'BUYER' | 'PRODUCER';

/** Por que o comprador não pode cancelar o pedido agora. */
export type CancellationBlock =
  'NOT_CONFIRMED' | 'WINDOW_EXPIRED' | 'TOO_CLOSE_TO_SHOW' | 'TICKET_USED';

/** Se o pedido pode ser cancelado pelo comprador, e até quando. */
export interface Cancellation {
  allowed: boolean;
  /** Preenchido quando não pode. */
  reason: CancellationBlock | string | null;
  /** Até quando pode cancelar (UTC). */
  deadline: string | null;
}

export interface Order {
  id: string;
  status: OrderStatus;
  showId: string;
  reservationId: string;
  /** O que o comprador pagou: subtotal − desconto + taxa (quando é dele). */
  totalCents: number;
  cancelReason: CancelReason | null;
  createdAt: string;
  confirmedAt: string | null;
  items: OrderItem[];
  tickets: Ticket[];
  // Fase 6. Opcionais: pedidos de antes não têm, e a loja não quebra sem eles.
  subtotalCents?: number;
  discountCents?: number;
  serviceFeeCents?: number;
  serviceFeePaidBy?: ServiceFeePayer;
  couponCode?: string | null;
  refundedCents?: number | null;
  refundedAt?: string | null;
  cancellation?: Cancellation;
}

/** Um cupom aplicado, como o orçamento devolve. */
export interface AppliedCoupon {
  code: string;
  kind: 'PERCENT' | 'AMOUNT';
  percent: number | null;
  amountCents: number | null;
}

/** Quanto o pedido de uma reserva vai custar, sem criar nada (`POST /orders/quote`). */
export interface OrderQuote {
  subtotalCents: number;
  discountCents: number;
  serviceFeeCents: number;
  serviceFeePaidBy: ServiceFeePayer;
  totalCents: number;
  coupon: AppliedCoupon | null;
}

/** Por que um cupom foi recusado (`coupon-invalid`). */
export type CouponInvalidReason =
  'NOT_FOUND' | 'EXPIRED' | 'PAUSED' | 'EXHAUSTED' | 'WRONG_SHOW' | 'WRONG_SECTOR';

/** Linha de "Meus ingressos". */
export interface OrderSummary {
  id: string;
  status: OrderStatus;
  showId: string;
  totalCents: number;
  /** Quantos ingressos o pedido tem (já emitidos ou não); a lista vem só no detalhe. */
  tickets: number;
  createdAt: string;
}
