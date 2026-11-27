import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { withTransaction } from '../database/transaction.js';
import type {
  CatalogShow,
  KnownMessage,
  TicketsCancelled,
  TicketsIssued,
} from '../messages/incoming.js';
import { planCancellation } from './cancellation-plan.js';
import {
  cancelTickets,
  insertIssuedTickets,
  lockTickets,
  markProcessed,
  upsertShow,
} from './local-copy.repository.js';

export type ApplyResult = 'applied' | 'duplicate' | 'stale';

/**
 * A cópia local da portaria (ADR 14): os ingressos, a partir de
 * `order.events`, e os shows, a partir de `shows.catalog`. Com ela, a
 * portaria valida o QR sem perguntar nada ao order-service, que pode estar
 * fora do ar no dia do show.
 *
 * Os ingressos são aplicados numa transação junto com o `eventId` em
 * `processed_events`: a mesma mensagem entregue de novo não muda nada. O show
 * usa a própria versão: fica a mais alta, e reler o tópico do começo
 * reconstrói o catálogo.
 */
@Injectable()
export class LocalCopyService {
  private readonly logger = new Logger(LocalCopyService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  handle(message: KnownMessage): Promise<ApplyResult> {
    switch (message.type) {
      case 'TicketsIssued':
        return this.issue(message);
      case 'TicketsCancelled':
        return this.cancel(message);
      case 'ShowPublished':
      case 'ShowUpdated':
        return this.updateShow(message);
    }
  }

  private async issue(message: TicketsIssued): Promise<ApplyResult> {
    const { orderId, tickets } = message.payload;
    const result = await withTransaction(this.pool, async (client) => {
      if (!(await markProcessed(client, message.eventId, message.type))) {
        return 'duplicate';
      }
      const inserted = await insertIssuedTickets(client, message);
      if (inserted < tickets.length) {
        this.logger.warn(
          `TicketsIssued do pedido ${orderId}: ${tickets.length - inserted} ingresso(s) já estavam na cópia local e ficaram como estavam`,
        );
      }
      return 'applied';
    });
    this.logResult(message, result, `${tickets.length} ingresso(s)`);
    return result;
  }

  private async cancel(message: TicketsCancelled): Promise<ApplyResult> {
    const { orderId, ticketIds, reason, cancelledAt } = message.payload;
    const result = await withTransaction(this.pool, async (client) => {
      if (!(await markProcessed(client, message.eventId, message.type))) {
        return 'duplicate';
      }
      const plan = planCancellation(
        ticketIds,
        await lockTickets(client, ticketIds),
      );
      if (plan.cancel.length > 0) {
        await cancelTickets(client, plan.cancel, reason, cancelledAt);
      }
      for (const { ticketId, status } of plan.refused) {
        this.logger.warn(
          `TicketsCancelled do pedido ${orderId}: o ingresso ${ticketId} está ${status} e não pode ser cancelado (transição fora da tabela)`,
        );
      }
      if (plan.missing.length > 0) {
        this.logger.warn(
          `TicketsCancelled do pedido ${orderId}: ingresso(s) fora da cópia local: ${plan.missing.join(', ')}`,
        );
      }
      return 'applied';
    });
    this.logResult(message, result, `${ticketIds.length} ingresso(s)`);
    return result;
  }

  private async updateShow(message: CatalogShow): Promise<ApplyResult> {
    const { showId, version } = message.payload;
    const result = (await upsertShow(this.pool, message)) ? 'applied' : 'stale';
    this.logResult(message, result, `show ${showId} v${version}`);
    return result;
  }

  private logResult(
    message: KnownMessage,
    result: ApplyResult,
    what: string,
  ): void {
    if (result === 'applied') {
      this.logger.log(`${message.type} aplicado: ${what}`);
    } else {
      this.logger.debug(
        `${message.type} ${message.eventId} (${what}) ${result === 'duplicate' ? 'já processado' : 'de versão antiga'}; ignorado`,
      );
    }
  }
}
