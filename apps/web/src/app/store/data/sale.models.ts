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
}

export interface Order {
  id: string;
  status: OrderStatus;
  showId: string;
  reservationId: string;
  totalCents: number;
  cancelReason: CancelReason | null;
  createdAt: string;
  confirmedAt: string | null;
  items: OrderItem[];
  tickets: Ticket[];
}

/** Linha de "Meus ingressos". */
export interface OrderSummary {
  id: string;
  status: OrderStatus;
  showId: string;
  totalCents: number;
  tickets: Ticket[];
  createdAt: string;
}
