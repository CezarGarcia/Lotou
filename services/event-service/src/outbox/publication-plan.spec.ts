import {
  planPublication,
  type Sequenced,
  streamOf,
} from './publication-plan.js';

let next = 0;
const message = (
  key: string,
  aggregateVersion: number,
  topic = 'shows.catalog',
): Sequenced => ({
  // IDs crescentes, como UUID v7 gerados em sequência.
  _id: String(next++).padStart(4, '0'),
  topic,
  key,
  aggregateVersion,
});

const versions = (list: Sequenced[]) =>
  list.map((m) => `${m.key}@${m.aggregateVersion}`);

describe('planPublication', () => {
  it('publica cada chave em ordem crescente de versão', () => {
    const pending = [message('a', 3), message('a', 2), message('a', 4)];

    const plan = planPublication(pending, new Map());

    expect(versions(plan.send)).toEqual(['a@2', 'a@3', 'a@4']);
    expect(plan.skip).toEqual([]);
  });

  it('mantém as chaves na ordem em que chegaram, sem misturar as versões', () => {
    const pending = [
      message('b', 5),
      message('a', 1),
      message('b', 4),
      message('a', 2),
    ];

    const plan = planPublication(pending, new Map());

    expect(versions(plan.send)).toEqual(['b@4', 'b@5', 'a@1', 'a@2']);
  });

  it('nunca publica uma versão menor que a última já publicada', () => {
    // O processo caiu no meio da marcação: a v3 ficou pendente, a v4 não.
    const pending = [message('a', 3), message('a', 5)];
    const published = new Map([
      [streamOf({ topic: 'shows.catalog', key: 'a' }), 4],
    ]);

    const plan = planPublication(pending, published);

    expect(versions(plan.send)).toEqual(['a@5']);
    expect(versions(plan.skip)).toEqual(['a@3']);
  });

  it('publica de novo a mesma versão (republicação do snapshot atual)', () => {
    const pending = [message('a', 4)];
    const published = new Map([
      [streamOf({ topic: 'shows.catalog', key: 'a' }), 4],
    ]);

    expect(versions(planPublication(pending, published).send)).toEqual(['a@4']);
  });

  it('a republicação que chega depois de uma mudança mais nova é descartada', () => {
    // Republicação lida na v4; enquanto isso, a v5 entrou e já foi publicada.
    const pending = [message('a', 4)];
    const published = new Map([
      [streamOf({ topic: 'shows.catalog', key: 'a' }), 5],
    ]);

    const plan = planPublication(pending, published);

    expect(plan.send).toEqual([]);
    expect(versions(plan.skip)).toEqual(['a@4']);
  });

  it('a mesma chave em tópicos diferentes são sequências independentes', () => {
    const pending = [message('a', 1, 'outro'), message('a', 2)];
    const published = new Map([[streamOf({ topic: 'outro', key: 'a' }), 9]]);

    const plan = planPublication(pending, published);

    expect(plan.send.map((m) => m.topic)).toEqual(['shows.catalog']);
    expect(plan.skip.map((m) => m.topic)).toEqual(['outro']);
  });

  it('a última mensagem publicada de cada chave é sempre a de versão mais alta', () => {
    // Propriedade, com pendentes embaralhadas e marcações parciais.
    for (let round = 0; round < 200; round++) {
      const keys = ['a', 'b', 'c'];
      const pending: Sequenced[] = [];
      const published = new Map<string, number>();
      for (const key of keys) {
        const last = Math.floor(Math.random() * 4);
        if (last > 0) {
          published.set(streamOf({ topic: 'shows.catalog', key }), last);
        }
        for (let v = 1; v <= 6; v++) {
          if (Math.random() < 0.5) {
            pending.push(message(key, v));
          }
        }
      }
      pending.sort(() => Math.random() - 0.5);

      const plan = planPublication(pending, published);

      for (const key of keys) {
        const sent = plan.send
          .filter((m) => m.key === key)
          .map((m) => m.aggregateVersion);
        const floor =
          published.get(streamOf({ topic: 'shows.catalog', key })) ?? 0;
        expect(sent).toEqual([...sent].sort((x, y) => x - y));
        expect(sent.every((v) => v >= floor)).toBe(true);
        const pendingOfKey = pending.filter((m) => m.key === key);
        expect(
          plan.send.filter((m) => m.key === key).length +
            plan.skip.filter((m) => m.key === key).length,
        ).toBe(pendingOfKey.length);
      }
    }
  });
});
