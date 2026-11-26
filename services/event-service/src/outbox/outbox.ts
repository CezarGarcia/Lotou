import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { traceHeaders } from '../telemetry/trace-context.js';
import { OutboxMessage } from './outbox.schema.js';

/** Uma mensagem pronta para o outbox: envelope serializado e onde publicar. */
export interface OutgoingMessage {
  eventId: string;
  topic: string;
  key: string;
  aggregateVersion: number;
  type: string;
  value: string;
}

/**
 * Grava mensagens no outbox. Quem muda um agregado chama `append` com a mesma
 * sessão da mudança: as duas gravações entram juntas ou nenhuma entra, e o
 * relay publica depois. Nada aqui fala com o Kafka.
 */
@Injectable()
export class Outbox {
  constructor(
    @InjectModel(OutboxMessage.name)
    private readonly messages: Model<OutboxMessage>,
  ) {}

  async append(
    messages: readonly OutgoingMessage[],
    session?: ClientSession,
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    // O trace de quem fez a mudança (a requisição HTTP, o job) segue com a
    // mensagem e continua no relay.
    const headers = traceHeaders();
    const createdAt = new Date();
    await this.messages.insertMany(
      messages.map(({ eventId, ...message }) => ({
        _id: eventId,
        ...message,
        headers,
        createdAt,
        publishedAt: null,
      })),
      { session },
    );
  }
}
