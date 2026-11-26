/** O mínimo que a ordem de publicação precisa saber de uma mensagem. */
export interface Sequenced {
  _id: string;
  topic: string;
  key: string;
  aggregateVersion: number;
}

export interface PublicationPlan<T> {
  /** Em ordem: por chave, da versão menor para a maior. */
  send: T[];
  /**
   * Mais antigas que a última versão já publicada da chave: não vão para o
   * Kafka, só são marcadas como publicadas.
   */
  skip: T[];
}

/** Tópico e chave juntos: a ordem só vale dentro de uma partição. */
export const streamOf = ({ topic, key }: Pick<Sequenced, 'topic' | 'key'>) =>
  `${topic}\u0000${key}`;

/**
 * Decide o que o relay publica, e em que ordem, a partir das mensagens
 * pendentes e da última versão já publicada de cada chave.
 *
 * - Dentro de uma chave, as mensagens saem em ordem crescente de versão.
 * - Uma versão menor que a última publicada nunca sai: no tópico compactado,
 *   a última mensagem da chave é a que fica, e ela tem de ser a mais nova.
 *   Isso cobre uma marcação que ficou pela metade (o processo caiu entre
 *   publicar e marcar) e uma republicação que chegou depois de uma mudança.
 * - A mesma versão sai de novo (republicação): é uma cópia da mais nova, e o
 *   consumidor ignora a repetição.
 *
 * As chaves saem na ordem em que aparecem em `pending`, para a mais antiga
 * não ficar esperando atrás das outras.
 */
export function planPublication<T extends Sequenced>(
  pending: readonly T[],
  lastPublished: ReadonlyMap<string, number>,
): PublicationPlan<T> {
  const byStream = new Map<string, T[]>();
  for (const message of pending) {
    const stream = streamOf(message);
    const list = byStream.get(stream) ?? [];
    list.push(message);
    byStream.set(stream, list);
  }

  const plan: PublicationPlan<T> = { send: [], skip: [] };
  for (const [stream, messages] of byStream) {
    messages.sort(
      (a, b) =>
        a.aggregateVersion - b.aggregateVersion || a._id.localeCompare(b._id),
    );
    let highest = lastPublished.get(stream) ?? 0;
    for (const message of messages) {
      if (message.aggregateVersion < highest) {
        plan.skip.push(message);
      } else {
        plan.send.push(message);
        highest = message.aggregateVersion;
      }
    }
  }
  return plan;
}
