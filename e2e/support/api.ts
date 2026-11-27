import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import {
  API_CLIENT_ID,
  API_CLIENT_SECRET,
  GATEWAY_URL,
  KEYCLOAK_URL,
  USER_AGENT,
  USUARIOS,
  type Papel,
} from './ambiente';
import { cpfAleatorio } from './dados';

/*
 * A API do Lotou pelo gateway, para os testes prepararem e conferirem dados:
 * achar os shows do seed, criar cupons, comprar um ingresso sem passar pela
 * loja. Só o que o teste precisa, com os nomes que a API usa.
 */

export interface Show {
  id: string;
  title: string;
  artist: string;
  status: string;
  startsAt: string;
  highDemand: boolean;
  serviceFeePaidBy: 'BUYER' | 'PRODUCER';
  venue?: { name: string; timezone: string };
}

export interface SetorDisponivel {
  id: string;
  name: string;
  kind: 'GENERAL_ADMISSION' | 'RESERVED_SEATING';
  sale: string;
  lot: { id: string; name: string; priceCents: number } | null;
  available: number;
}

export interface Reserva {
  id: string;
  status: string;
  totalCents: number;
}

export interface Ingresso {
  id: string;
  code: string;
  status: string;
  seat: string | null;
}

export interface Pedido {
  id: string;
  status: string;
  subtotalCents: number;
  discountCents: number;
  serviceFeeCents: number;
  serviceFeePaidBy: 'BUYER' | 'PRODUCER';
  totalCents: number;
  tickets: Ingresso[];
}

interface Pagina<T> {
  items: T[];
  nextCursor: string | null;
}

/** Access token de um usuário de demonstração (fluxo de senha, só no cliente de desenvolvimento). */
export async function tokenDe(request: APIRequestContext, papel: Papel): Promise<string> {
  const { username, password } = USUARIOS[papel];
  const response = await request.post(
    `${KEYCLOAK_URL}/realms/lotou/protocol/openid-connect/token`,
    {
      headers: { 'User-Agent': USER_AGENT },
      form: {
        grant_type: 'password',
        client_id: API_CLIENT_ID,
        client_secret: API_CLIENT_SECRET,
        username,
        password,
        scope: 'openid',
      },
    },
  );
  if (!response.ok()) {
    throw new Error(`O Keycloak recusou o login de ${username}: ${response.status()}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

const espera = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** O gateway, como um usuário (com token) ou como um visitante (sem). */
export class Gateway {
  constructor(
    private readonly request: APIRequestContext,
    private readonly token?: string,
  ) {}

  static async como(request: APIRequestContext, papel: Papel): Promise<Gateway> {
    return new Gateway(request, await tokenDe(request, papel));
  }

  async get<T>(caminho: string): Promise<T> {
    return this.chamar<T>('GET', caminho);
  }

  /** POST com `Idempotency-Key` nova: cada chamada cria um recurso. */
  async post<T>(caminho: string, corpo: unknown): Promise<T> {
    return this.chamar<T>('POST', caminho, corpo);
  }

  private async chamar<T>(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<T> {
    const response = await this.request.fetch(`${GATEWAY_URL}/api/v1${caminho}`, {
      method: metodo,
      headers: {
        'User-Agent': USER_AGENT,
        ...(this.token && { Authorization: `Bearer ${this.token}` }),
        ...(metodo === 'POST' && { 'Idempotency-Key': randomUUID() }),
      },
      data: corpo,
    });
    if (!response.ok()) {
      // Problem Details (RFC 9457): o título e o detalhe dizem o que deu errado.
      const problema = (await response.json().catch(() => ({}))) as {
        title?: string;
        detail?: string;
      };
      throw new Error(
        `${metodo} ${caminho} -> ${response.status()} ${problema.title ?? ''}: ${problema.detail ?? ''}`,
      );
    }
    return (await response.json()) as T;
  }

  /** Todos os shows da busca, seguindo o cursor. */
  async shows(): Promise<Show[]> {
    const shows: Show[] = [];
    let cursor: string | null = null;
    do {
      const pagina: Pagina<Show> = await this.get(
        `/shows?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      shows.push(...pagina.items);
      cursor = pagina.nextCursor;
    } while (cursor);
    return shows;
  }

  /** Um show do seed pelo título. Sem ele, o ambiente não recebeu o `make seed`. */
  async showDoSeed(titulo: string): Promise<Show> {
    const show = (await this.shows()).find((item) => item.title === titulo);
    if (!show) {
      throw new Error(`O show "${titulo}" não está na busca. Rodou 'make seed'?`);
    }
    return show;
  }

  async disponibilidade(showId: string): Promise<SetorDisponivel[]> {
    return (await this.get<{ sectors: SetorDisponivel[] }>(`/availability/${showId}`)).sectors;
  }

  /** O setor à venda agora, com o lote e o preço do momento. */
  async setorAVenda(showId: string, nome: string): Promise<SetorDisponivel> {
    const setor = (await this.disponibilidade(showId)).find((item) => item.name === nome);
    if (!setor || setor.sale !== 'ON_SALE' || !setor.lot) {
      throw new Error(`O setor ${nome} não está à venda: ${JSON.stringify(setor)}`);
    }
    return setor;
  }

  /**
   * O show de hoje do seed ("Ensaio Aberto DD/MM", portões abertos), com a
   * pista à venda. O seed de cada dia cria o seu; o de hoje começa nas
   * próximas horas.
   */
  async showDeHoje(): Promise<{ show: Show; pista: SetorDisponivel }> {
    const agora = Date.now();
    const candidatos = (await this.shows())
      .filter(
        (show) =>
          show.artist === 'Coletivo Pé de Serra' &&
          Date.parse(show.startsAt) > agora &&
          Date.parse(show.startsAt) - agora < 12 * 3_600_000,
      )
      .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
    for (const show of candidatos) {
      const pista = (await this.disponibilidade(show.id)).find(
        (setor) => setor.name === 'Pista' && setor.sale === 'ON_SALE',
      );
      if (pista) {
        return { show, pista };
      }
    }
    throw new Error("Nenhum show de hoje com a pista à venda. Rode 'make seed' hoje.");
  }

  /** Cria um cupom percentual (como o produtor) e devolve o código. */
  async criarCupom(showId: string, codigo: string, percent: number, maxUses = 5): Promise<string> {
    const cupom = await this.post<{ code: string }>('/coupons', {
      showId,
      code: codigo,
      kind: 'PERCENT',
      percent,
      maxUses,
      // Vale por um dia: o bastante para a execução, sem acumular cupons ativos.
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    });
    return cupom.code;
  }

  async reserva(id: string): Promise<Reserva> {
    return this.get<Reserva>(`/reservations/${id}`);
  }

  async pedido(id: string): Promise<Pedido> {
    return this.get<Pedido>(`/orders/${id}`);
  }

  /** Acompanha o pedido até sair de `PENDING` (a saga anda pelo Kafka). */
  async esperarPedido(id: string, tentativas = 60): Promise<Pedido> {
    let pedido = await this.pedido(id);
    for (let i = 0; i < tentativas && pedido.status === 'PENDING'; i++) {
      await espera(500);
      pedido = await this.pedido(id);
    }
    return pedido;
  }

  /** Compra um ingresso de pista como o comprador faria pela API: reserva, pedido e saga. */
  async comprarPista(showId: string, setor: SetorDisponivel): Promise<Pedido> {
    const reserva = await this.post<Reserva>('/reservations', {
      showId,
      sectorId: setor.id,
      quantity: 1,
      cpf: cpfAleatorio(),
    });
    const criado = await this.post<Pedido>('/orders', { reservationId: reserva.id });
    const pedido = await this.esperarPedido(criado.id);
    if (pedido.status !== 'CONFIRMED' || pedido.tickets.length !== 1) {
      throw new Error(`O pedido não foi confirmado: ${JSON.stringify(pedido)}`);
    }
    return pedido;
  }
}
