import { FEED_LIMIT, INITIAL_DASHBOARD, mergeFeed, reduceDashboard } from './dashboard.state';
import { LiveShowEvent } from './live-dashboard.client';
import { confirmedEntry, liveMetrics } from './live.testing';

const NOW = Date.UTC(2026, 10, 26, 18, 1, 0);

/** Aplica uma sequência de mensagens a partir do estado inicial. */
const run = (...events: LiveShowEvent[]) =>
  events.reduce((state, event, i) => reduceDashboard(state, event, NOW + i), INITIAL_DASHBOARD);

const ids = (entries: { id: string }[]) => entries.map((entry) => entry.id);

describe('reduceDashboard', () => {
  it('começa vazio e monta o painel com a foto', () => {
    const metrics = liveMetrics();
    const state = run({
      type: 'snapshot',
      metrics,
      activity: [confirmedEntry(3), confirmedEntry(2), confirmedEntry(1)],
    });

    expect(state.metrics).toBe(metrics);
    expect(ids(state.activity)).toEqual(
      ids([confirmedEntry(3), confirmedEntry(2), confirmedEntry(1)]),
    );
    expect(state.updatedAt).toBe(NOW);
    // As entradas da foto não são novidade: nada a anunciar.
    expect(state.liveCount).toBe(0);
  });

  it('métricas substituem as anteriores, mas uma mais velha que a da tela é ignorada', () => {
    const newer = liveMetrics({ at: '2026-11-26T18:00:05Z', ticketsSold: 1300 });
    const older = liveMetrics({ at: '2026-11-26T18:00:04Z', ticketsSold: 1290 });
    const state = run(
      { type: 'snapshot', metrics: liveMetrics(), activity: [] },
      { type: 'metrics', metrics: newer },
      { type: 'metrics', metrics: older },
    );
    expect(state.metrics).toBe(newer);
    expect(state.updatedAt).toBe(NOW + 1);
  });

  it('aceita métricas antes da primeira foto', () => {
    const metrics = liveMetrics();
    expect(run({ type: 'metrics', metrics }).metrics).toBe(metrics);
  });

  it('põe a atividade nova no topo e conta o que chegou ao vivo', () => {
    const state = run(
      { type: 'snapshot', metrics: liveMetrics(), activity: [confirmedEntry(1)] },
      { type: 'activity', entry: confirmedEntry(2) },
      { type: 'activity', entry: confirmedEntry(3) },
    );
    expect(ids(state.activity)).toEqual(
      ids([confirmedEntry(3), confirmedEntry(2), confirmedEntry(1)]),
    );
    expect(state.liveCount).toBe(2);
    expect(state.lastLive?.id).toBe(confirmedEntry(3).id);
  });

  it('não repete uma entrada que já está no feed', () => {
    const before = run({ type: 'snapshot', metrics: liveMetrics(), activity: [confirmedEntry(1)] });
    const after = reduceDashboard(before, { type: 'activity', entry: confirmedEntry(1) }, NOW + 9);
    expect(after).toBe(before);
  });

  it('ordena pela posição no stream mesmo quando a entrada chega fora de ordem', () => {
    const state = run(
      { type: 'activity', entry: confirmedEntry(5) },
      { type: 'activity', entry: confirmedEntry(3) },
      { type: 'activity', entry: confirmedEntry(4) },
    );
    expect(ids(state.activity)).toEqual(
      ids([confirmedEntry(5), confirmedEntry(4), confirmedEntry(3)]),
    );
  });

  it('desempata pela sequência dentro do mesmo milissegundo', () => {
    const a = confirmedEntry(1, { id: '1764180001000-0' });
    const b = confirmedEntry(1, { id: '1764180001000-1', eventId: 'outro' });
    expect(ids(mergeFeed([], [a, b]))).toEqual(['1764180001000-1', '1764180001000-0']);
  });

  it(`guarda só as ${FEED_LIMIT} entradas mais novas`, () => {
    const snapshot = Array.from({ length: FEED_LIMIT }, (_, i) => confirmedEntry(FEED_LIMIT - i));
    let state = run({ type: 'snapshot', metrics: liveMetrics(), activity: snapshot });
    expect(state.activity).toHaveLength(FEED_LIMIT);

    state = reduceDashboard(state, { type: 'activity', entry: confirmedEntry(51) }, NOW);
    expect(state.activity).toHaveLength(FEED_LIMIT);
    expect(state.activity[0].id).toBe(confirmedEntry(51).id);
    expect(state.activity.at(-1)?.id).toBe(confirmedEntry(2).id);

    // Uma entrada mais velha que todas as 50 não entra nem é anunciada.
    const stale = reduceDashboard(state, { type: 'activity', entry: confirmedEntry(0) }, NOW);
    expect(stale).toBe(state);
  });

  it('a foto de uma reconexão substitui o feed, sem perder a contagem do que foi anunciado', () => {
    const state = run(
      { type: 'snapshot', metrics: liveMetrics(), activity: [confirmedEntry(1)] },
      { type: 'activity', entry: confirmedEntry(2) },
      {
        type: 'snapshot',
        metrics: liveMetrics(),
        activity: [confirmedEntry(4), confirmedEntry(3), confirmedEntry(2)],
      },
    );
    expect(ids(state.activity)).toEqual(
      ids([confirmedEntry(4), confirmedEntry(3), confirmedEntry(2)]),
    );
    expect(state.liveCount).toBe(1);
  });

  it('show recusado limpa o painel', () => {
    const state = run(
      { type: 'snapshot', metrics: liveMetrics(), activity: [confirmedEntry(1)] },
      { type: 'forbidden', detail: 'Show' },
    );
    expect(state.forbidden).toBe(true);
    expect(state.metrics).toBeNull();
    expect(state.activity).toEqual([]);
  });
});
