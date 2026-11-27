import { WebSocketLike } from './live-dashboard.client';
import { ActivityEntry, LiveMetrics } from './live.protocol';

/**
 * Apoio aos testes do painel ao vivo. Nada daqui entra no pacote da loja: só
 * os testes importam este arquivo.
 */

/**
 * WebSocket falso: guarda o que o cliente mandou e deixa o teste fazer o papel
 * do servidor (abrir, mandar frames, fechar com um código).
 */
export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  /** Mensagens que o cliente mandou, já lidas do JSON. */
  readonly sent: Record<string, unknown>[] = [];
  /** Código com que o cliente fechou a conexão. */
  closedByClient: number | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) {
      throw new Error('WebSocket não está aberto');
    }
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000): void {
    this.closedByClient = code;
    this.readyState = 3;
  }

  // O lado do servidor.

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** Um frame do servidor: objetos viram JSON; texto e binário vão como estão. */
  receive(message: unknown): void {
    const data =
      typeof message === 'object' && message !== null && !(message instanceof ArrayBuffer)
        ? JSON.stringify(message)
        : message;
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code }));
  }

  /** Mensagens de um tipo, na ordem em que foram mandadas. */
  sentOf(type: string): Record<string, unknown>[] {
    return this.sent.filter((message) => message['type'] === type);
  }
}

/** Métricas de teste: pista com o 2º lote em venda e camarote antes da abertura. */
export function liveMetrics(overrides: Partial<LiveMetrics> = {}): LiveMetrics {
  return {
    at: '2026-11-26T18:00:01Z',
    ticketsSold: 1240,
    revenueCents: 18_600_000,
    ordersConfirmed: 610,
    ordersCancelled: 42,
    ordersLastMinute: 37,
    sectors: [
      {
        sectorId: 'sec-pista',
        name: 'Pista',
        capacity: 2000,
        sold: 1180,
        remaining: 820,
        currentLot: { lotId: 'lot-2', name: '2º lote', priceCents: 15_000, status: 'ON_SALE' },
      },
      {
        sectorId: 'sec-camarote',
        name: 'Camarote',
        capacity: 100,
        sold: 60,
        remaining: 40,
        currentLot: null,
      },
    ],
    ...overrides,
  };
}

/** Pedido confirmado no feed; `seq` define o ID do stream e o instante (18:00:seq UTC). */
export function confirmedEntry(seq: number, overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: `${1764180000000 + seq * 1000}-0`,
    eventId: `evt-${seq}`,
    type: 'OrderConfirmed',
    at: new Date(Date.UTC(2026, 10, 26, 18, 0, seq)).toISOString(),
    orderId: `ord-${seq}`,
    sectorName: 'Pista',
    quantity: 2,
    totalCents: 30_000,
    ...overrides,
  } as ActivityEntry;
}
