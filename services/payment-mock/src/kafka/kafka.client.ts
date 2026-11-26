import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';

/**
 * Leva os logs do cliente (librdkafka) ao logger da aplicação, em JSON e com
 * trace_id como os demais. O cliente é falante: INFO dele vira debug aqui.
 */
export function kafkaLogger(context = 'Kafka'): KafkaJS.Logger {
  const logger = new Logger(context);
  const adapter: KafkaJS.Logger = {
    info: (message) => logger.debug(message),
    debug: (message) => logger.verbose(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
    namespace: (namespace) => kafkaLogger(`${context}:${namespace}`),
    setLogLevel: () => undefined,
  };
  return adapter;
}

export function createKafka(brokers: string[]): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      clientId: 'payment-mock',
      brokers,
      logger: kafkaLogger(),
      logLevel: KafkaJS.logLevel.WARN,
    },
  });
}

/**
 * Produtor idempotente com `acks=all`: o broker só confirma depois de gravar
 * em todas as réplicas em sincronia, e uma nova tentativa de envio não
 * duplica a mensagem nem troca a ordem dentro da partição.
 */
export function createProducer(kafka: KafkaJS.Kafka): KafkaJS.Producer {
  return kafka.producer({
    kafkaJS: { idempotent: true, acks: -1 },
    // Junta as mensagens de alguns milissegundos num lote só.
    'linger.ms': 5,
    // Quanto um envio pode levar, com as novas tentativas, antes de falhar.
    'message.timeout.ms': 30_000,
  });
}
