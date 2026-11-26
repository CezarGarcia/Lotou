import type { Model } from 'mongoose';
import { Outbox } from '../outbox/outbox.js';
import type { OutboxMessage } from '../outbox/outbox.schema.js';
import { catalogMessage } from './catalog-message.js';
import type { Show } from './show.schema.js';

const BATCH_SIZE = 100;

/**
 * Põe no outbox o snapshot atual de todo show fora do rascunho, como
 * `ShowUpdated`. Serve para o ambiente que já tinha shows antes do Kafka: o
 * relay publica e o tópico compactado passa a ter todos eles.
 *
 * Não precisa de transação nem de parar o serviço. Cada snapshot leva a
 * versão que o show tinha na leitura; se o show mudar no meio, a versão nova
 * sai pelo caminho normal, e o relay nunca publica a republicação depois
 * dela (`planPublication`). Rodar duas vezes só repete mensagens, que o
 * consumidor ignora pela versão.
 */
export async function republishCatalog(
  shows: Model<Show>,
  messages: Model<OutboxMessage>,
): Promise<number> {
  const outbox = new Outbox(messages);
  let count = 0;
  let batch: Show[] = [];
  const flush = async () => {
    await outbox.append(
      batch.map((show) => catalogMessage('ShowUpdated', show)),
    );
    count += batch.length;
    batch = [];
  };

  for await (const show of shows
    .find({ status: { $ne: 'DRAFT' } })
    .sort({ _id: 1 })
    .lean()
    .cursor()) {
    batch.push(show as Show);
    if (batch.length === BATCH_SIZE) {
      await flush();
    }
  }
  await flush();
  return count;
}
