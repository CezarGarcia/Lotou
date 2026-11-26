import type { KafkaJS } from '@confluentinc/kafka-javascript';

/** Uma mensagem recebida do Kafka, com o necessário para processar e para a DLT. */
export interface IncomingMessage {
  topic: string;
  partition: number;
  offset: string;
  key: Buffer | null;
  value: Buffer | null;
  headers?: KafkaJS.IHeaders;
}
