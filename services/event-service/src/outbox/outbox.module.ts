import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Outbox } from './outbox.js';
import { OutboxMetrics } from './outbox.metrics.js';
import { OutboxRelay } from './outbox.relay.js';
import {
  OutboxLease,
  OutboxLeaseSchema,
  OutboxMessage,
  OutboxMessageSchema,
} from './outbox.schema.js';

/**
 * Outbox transacional no MongoDB (ADR 29): quem muda um show grava a mensagem
 * na mesma transação (`Outbox`), e o relay a publica no Kafka.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OutboxMessage.name, schema: OutboxMessageSchema },
      { name: OutboxLease.name, schema: OutboxLeaseSchema },
    ]),
  ],
  providers: [Outbox, OutboxMetrics, OutboxRelay],
  exports: [Outbox],
})
export class OutboxModule {}
