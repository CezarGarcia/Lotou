/** Tópicos do checkin-service (contracts/README.md). Criados pelo `kafka-init`. */
export const TOPICS = {
  /** Ingressos emitidos e cancelados (e outros fatos do pedido); chave `orderId`. */
  orderEvents: 'order.events',
  /** Catálogo de shows, compactado; chave `showId`. */
  catalog: 'shows.catalog',
  /** Entradas e leituras recusadas, publicadas pelo outbox; chave `showId`. */
  checkinEvents: 'checkin.events',
} as const;

/** Tópicos que o serviço consome; cada um tem a sua DLT. */
export const CONSUMED_TOPICS: readonly string[] = [
  TOPICS.orderEvents,
  TOPICS.catalog,
];

/** A DLT de um tópico: `<tópico>.dlt`, criada pelo `kafka-init`. */
export const dltOf = (topic: string): string => `${topic}.dlt`;

/** Consumer group do serviço: as instâncias dividem as partições entre si. */
export const CONSUMER_GROUP = 'checkin-service';
