import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';

/** Tópicos que o event-service usa (contracts/README.md). */
export const TOPICS = {
  catalog: 'shows.catalog',
  inventoryEvents: 'inventory.events',
  inventoryEventsDlt: 'inventory.events.dlt',
} as const;

const CLIENT_ID = 'event-service';

/**
 * Cliente do Kafka (`@confluentinc/kafka-javascript`, API compatível com a do
 * KafkaJS sobre o librdkafka). Criar o cliente não abre conexão: cada produtor
 * e consumidor conecta quando é usado.
 */
export function createKafka(brokers: string[]): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: {
      brokers,
      clientId: CLIENT_ID,
      logger: nestLogger('Kafka'),
      logLevel: KafkaJS.logLevel.WARN,
    },
  });
}

/** Os logs do librdkafka no mesmo logger da aplicação (JSON, com trace). */
function nestLogger(
  context: string,
  level = KafkaJS.logLevel.WARN,
): KafkaJS.Logger {
  const logger = new Logger(context);
  let current = level;
  const at =
    (min: KafkaJS.logLevel, write: (message: string) => void) =>
    (message: string, extra?: object) => {
      if (current >= min) {
        write(extra ? `${message} ${JSON.stringify(extra)}` : message);
      }
    };
  const adapter: KafkaJS.Logger = {
    error: at(KafkaJS.logLevel.ERROR, (m) => logger.error(m)),
    warn: at(KafkaJS.logLevel.WARN, (m) => logger.warn(m)),
    info: at(KafkaJS.logLevel.INFO, (m) => logger.log(m)),
    debug: at(KafkaJS.logLevel.DEBUG, (m) => logger.debug(m)),
    namespace: () => adapter,
    setLogLevel: (next) => {
      current = next;
    },
  };
  return adapter;
}

/** Cabeçalhos da mensagem como texto; o Kafka os entrega como bytes. */
export function headersAsText(
  headers: KafkaJS.IHeaders | undefined,
): Record<string, string> {
  const text: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) {
      text[name] = first.toString();
    }
  }
  return text;
}
