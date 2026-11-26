/** Tópicos do payment-mock (contracts/README.md). Criados pelo `kafka-init`. */
export const TOPICS = {
  /** Comandos do order-service; chave `orderId`. */
  commands: 'payment.commands',
  /** Respostas ao order-service; chave `orderId`. */
  events: 'payment.events',
  /** Comandos que falharam depois das tentativas, para inspeção manual. */
  commandsDlt: 'payment.commands.dlt',
} as const;

/** Consumer group do serviço: as instâncias dividem as partições entre si. */
export const CONSUMER_GROUP = 'payment-mock';
