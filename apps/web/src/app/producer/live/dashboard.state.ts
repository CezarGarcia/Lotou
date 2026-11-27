import { LiveShowEvent } from './live-dashboard.client';
import { ActivityEntry, LiveMetrics } from './live.protocol';

/** Quantas entradas o feed guarda: as mesmas 50 que a foto do servidor traz. */
export const FEED_LIMIT = 50;

/** Estado do painel de um show, montado a partir das mensagens do WebSocket. */
export interface DashboardState {
  /** `null` até chegar a primeira foto ou métrica. */
  metrics: LiveMetrics | null;
  /** Do mais novo ao mais antigo, no máximo `FEED_LIMIT`. */
  activity: ActivityEntry[];
  /**
   * Quantas entradas chegaram ao vivo (fora das fotos) desde que a tela abriu.
   * Só cresce: o anúncio para leitores de tela compara com o que já anunciou.
   */
  liveCount: number;
  /** A entrada mais recente que chegou ao vivo. */
  lastLive: ActivityEntry | null;
  /** Quando o painel recebeu dados deste show pela última vez (relógio do navegador). */
  updatedAt: number | null;
  /** O servidor recusou o show (de outro produtor ou inexistente). */
  forbidden: boolean;
}

export const INITIAL_DASHBOARD: DashboardState = {
  metrics: null,
  activity: [],
  liveCount: 0,
  lastLive: null,
  updatedAt: null,
  forbidden: false,
};

/** Partes do ID do Redis Stream (`<ms>-<seq>`); `null` se não estiver nesse formato. */
function streamId(id: string): [number, number] | null {
  const match = /^(\d+)-(\d+)$/.exec(id);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * Ordem do feed: a mais nova primeiro. O ID do stream dá a ordem de chegada ao
 * analytics; sem ele, vale o instante do fato.
 */
export function compareNewestFirst(a: ActivityEntry, b: ActivityEntry): number {
  const left = streamId(a.id);
  const right = streamId(b.id);
  if (left && right) {
    return right[0] - left[0] || right[1] - left[1];
  }
  return Date.parse(b.at) - Date.parse(a.at);
}

/** Junta entradas ao feed sem repetir IDs, na ordem do feed e com o limite. */
export function mergeFeed(
  feed: readonly ActivityEntry[],
  entries: readonly ActivityEntry[],
): ActivityEntry[] {
  const known = new Set(feed.map((entry) => entry.id));
  const added = entries.filter((entry) => {
    if (known.has(entry.id)) {
      return false;
    }
    known.add(entry.id);
    return true;
  });
  if (added.length === 0) {
    return feed as ActivityEntry[];
  }
  return [...added, ...feed].sort(compareNewestFirst).slice(0, FEED_LIMIT);
}

const isOlder = (next: LiveMetrics, current: LiveMetrics | null) =>
  current !== null && Date.parse(next.at) < Date.parse(current.at);

/**
 * Aplica uma mensagem ao estado. Função pura: o mesmo estado e a mesma
 * mensagem dão sempre o mesmo resultado.
 *
 * - `snapshot` substitui tudo: chega depois de cada assinatura, inclusive
 *   numa reconexão, e traz as 50 entradas mais novas.
 * - `metrics` substitui as métricas, a menos que sejam mais antigas que as da tela.
 * - `activity` entra no feed na posição certa, sem repetir uma entrada já vista.
 */
export function reduceDashboard(
  state: DashboardState,
  event: LiveShowEvent,
  now: number,
): DashboardState {
  switch (event.type) {
    case 'snapshot':
      return {
        ...state,
        metrics: event.metrics,
        activity: mergeFeed([], event.activity),
        updatedAt: now,
        forbidden: false,
      };
    case 'metrics':
      return isOlder(event.metrics, state.metrics)
        ? state
        : { ...state, metrics: event.metrics, updatedAt: now };
    case 'activity': {
      const activity = mergeFeed(state.activity, [event.entry]);
      if (activity === state.activity) {
        return state;
      }
      // Uma entrada mais velha que as 50 do feed não aparece nem é anunciada.
      return activity.includes(event.entry)
        ? {
            ...state,
            activity,
            liveCount: state.liveCount + 1,
            lastLive: event.entry,
            updatedAt: now,
          }
        : state;
    }
    case 'forbidden':
      return { ...INITIAL_DASHBOARD, liveCount: state.liveCount, forbidden: true };
  }
}
