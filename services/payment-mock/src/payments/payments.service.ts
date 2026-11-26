import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { withTransaction } from '../database/transaction.js';
import { TOPICS } from '../kafka/topics.js';
import type { TraceHeaders } from '../kafka/trace-headers.js';
import type { PaymentCommand } from '../messages/commands.js';
import type { PaymentEvent } from '../messages/events.js';
import { enqueue } from '../outbox/outbox.repository.js';
import { OutboxRelay } from '../outbox/outbox.relay.js';
import type { Payment } from './payment.js';
import { PaymentMetrics } from './payment-metrics.js';
import {
  GatewayDecisionRequired,
  needsAuthorization,
  needsRefund,
  type PaymentPlan,
  planAuthorize,
  planRefund,
} from './payment-plan.js';
import {
  findByOrder,
  insertPayment,
  isProcessed,
  markProcessed,
  updatePayment,
} from './payments.repository.js';
import {
  type AuthorizationDecision,
  type RefundDecision,
  SimulatedGateway,
} from './simulated-gateway.js';

export type HandleResult =
  /** O `eventId` já tinha sido processado: nada muda, nada é publicado. */
  | { outcome: 'duplicate' }
  | { outcome: 'answered'; event: PaymentEvent; plan: PaymentPlan };

/** Quantas vezes recomeçar se o pagamento mudar entre a leitura e a transação. */
const MAX_STALE_RETRIES = 3;

/**
 * Processa os comandos de pagamento. Para cada um, numa única transação:
 * registra o `eventId` em `processed_events`, grava a decisão em `payments` e a
 * resposta no outbox. Ou tudo fica gravado, ou nada.
 *
 * A chamada ao gateway simulado (com a latência) acontece antes da transação,
 * para não segurar conexão nem lock enquanto "o banco" responde. Se o
 * pagamento mudou nesse meio-tempo (outra instância decidiu primeiro), a
 * decisão é descartada e o comando recomeça; como o gateway real seria
 * chamado com o pedido como chave de idempotência, descartar não cobra nada.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly gateway: SimulatedGateway,
    private readonly relay: OutboxRelay,
    private readonly metrics: PaymentMetrics,
  ) {}

  async handle(
    command: PaymentCommand,
    trace: TraceHeaders = {},
  ): Promise<HandleResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.handleOnce(command, trace);
      } catch (error) {
        if (
          error instanceof GatewayDecisionRequired &&
          attempt < MAX_STALE_RETRIES
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  private async handleOnce(
    command: PaymentCommand,
    trace: TraceHeaders,
  ): Promise<HandleResult> {
    const { eventId, type } = command;
    const { orderId } = command.payload;

    // Atalho para a entrega repetida, sem chamar o gateway; a transação
    // confere de novo.
    if (await isProcessed(this.pool, eventId)) {
      this.logger.debug(`${type} ${eventId} já processado; ignorado`);
      return { outcome: 'duplicate' };
    }
    const decision = await this.decide(
      command,
      await findByOrder(this.pool, orderId),
    );

    const result = await withTransaction(
      this.pool,
      async (client): Promise<HandleResult> => {
        if (!(await markProcessed(client, eventId, type))) {
          return { outcome: 'duplicate' };
        }
        const current = await findByOrder(client, orderId, { lock: true });
        const plan = this.plan(command, current, decision);
        if (plan.insert && !(await insertPayment(client, plan.insert))) {
          // Outra transação criou o pagamento depois da leitura.
          throw new GatewayDecisionRequired();
        }
        if (plan.update) {
          await updatePayment(client, plan.update);
        }
        await enqueue(client, {
          topic: TOPICS.events,
          key: orderId,
          event: plan.event,
          headers: trace,
        });
        return { outcome: 'answered', event: plan.event, plan };
      },
    );

    if (result.outcome === 'answered') {
      this.relay.notify();
      this.report(command, result.plan);
    } else {
      this.logger.debug(`${type} ${eventId} já processado; ignorado`);
    }
    return result;
  }

  /** Consulta o gateway só quando há algo a cobrar ou estornar. */
  private async decide(
    command: PaymentCommand,
    current: Payment | undefined,
  ): Promise<AuthorizationDecision | RefundDecision | undefined> {
    if (command.type === 'AuthorizePayment') {
      return needsAuthorization(current) ? this.gateway.authorize() : undefined;
    }
    return needsRefund(current) ? this.gateway.refund() : undefined;
  }

  private plan(
    command: PaymentCommand,
    current: Payment | undefined,
    decision: AuthorizationDecision | RefundDecision | undefined,
  ): PaymentPlan {
    const now = new Date();
    return command.type === 'AuthorizePayment'
      ? planAuthorize(
          command,
          current,
          decision as AuthorizationDecision | undefined,
          now,
        )
      : planRefund(
          command,
          current,
          decision as RefundDecision | undefined,
          now,
        );
  }

  private report(command: PaymentCommand, plan: PaymentPlan): void {
    const { orderId } = command.payload;
    if (plan.result) {
      this.metrics.record(plan.result);
    }
    if (plan.warning) {
      this.logger.warn(`Pedido ${orderId}: ${plan.warning}`);
    }
    this.logger.log(
      `${command.type} do pedido ${orderId}: ${plan.event.type}${plan.result ? '' : ' (sem nova decisão do gateway)'}`,
    );
  }
}
