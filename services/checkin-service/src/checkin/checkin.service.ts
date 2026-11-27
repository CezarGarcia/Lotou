import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { context, type Span, trace } from '@opentelemetry/api';
import type { Pool } from 'pg';
import { newId } from '../common/ids.js';
import type { Env } from '../config/env.js';
import { PG_POOL } from '../database/database.module.js';
import { withTransaction } from '../database/transaction.js';
import { TOPICS } from '../kafka/topics.js';
import { type TraceHeaders, traceHeadersFrom } from '../kafka/trace-headers.js';
import {
  type RejectionReason,
  ticketCheckedIn,
} from '../messages/checkin-events.js';
import { enqueue } from '../outbox/outbox.repository.js';
import { OutboxRelay } from '../outbox/outbox.relay.js';
import {
  type CheckinResponse,
  type CheckinResult,
  evaluate,
  type FirstEntry,
  RESULT_COLORS,
  type ScannedTicket,
  toResponse,
} from './checkin-result.js';
import {
  findEntry,
  findScannedTicket,
  insertCheckin,
  markUsed,
} from './checkins.repository.js';
import { FirstEntryStore } from './first-entry.store.js';
import { RejectionBuffer } from './rejection-buffer.js';
import { TicketCodeVerifier } from './ticket-code.js';

export interface Scan {
  showId: string;
  gate: string;
  /** Conteúdo do QR code. Nunca vai para log nem para span. */
  code: string;
}

/** O ingresso deixou de ser `VALID` entre a consulta e a gravação. */
class CancelledMeanwhile extends Error {}

/** O resultado da gravação da entrada no Postgres. */
type Recorded =
  | { result: 'ACCEPTED' }
  | { result: 'ALREADY_USED'; entry: FirstEntry | undefined }
  | { result: 'CANCELLED' };

/**
 * A leitura do QR code na portaria (docs/projeto.md, "Fluxo E").
 *
 * 1. Confere a assinatura do código, sem consultar nada: falsificado ou
 *    malformado é `INVALID_CODE`, e o banco nem é tocado.
 * 2. Busca o ingresso na cópia local (uma consulta pela chave primária):
 *    desconhecido, de outro show, cancelado, já usado ou antes da abertura dos
 *    portões são recusados.
 * 3. Dois portões com o mesmo QR ao mesmo tempo: `SET NX` em
 *    `checkin:{ticketId}` no Redis decide quem é o primeiro, sem esperar o
 *    banco; os outros recebem "já utilizado" com o horário e o portão.
 * 4. O primeiro grava a entrada em `checkins` e o `TicketCheckedIn` no outbox,
 *    numa transação. A constraint única de `ticket_id` é a palavra final: com o
 *    Redis fora ou sem os dados, ela sozinha deixa uma entrada só.
 *
 * Toda recusa vira um `CheckinRejected`, gravado em lote fora da requisição
 * (RejectionBuffer).
 */
@Injectable()
export class CheckinService {
  private readonly logger = new Logger(CheckinService.name);
  private readonly codes: TicketCodeVerifier;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly firstEntries: FirstEntryStore,
    private readonly rejections: RejectionBuffer,
    private readonly relay: OutboxRelay,
    config: ConfigService<Env, true>,
  ) {
    this.codes = new TicketCodeVerifier(
      config.get('TICKET_QR_KEY', { infer: true }),
    );
  }

  /**
   * `incoming` são os cabeçalhos de trace que vieram na requisição: valem
   * quando não há SDK do OpenTelemetry (nos testes), para o trace seguir
   * mesmo assim até o Kafka.
   */
  async scan(
    scan: Scan,
    incoming: TraceHeaders = {},
  ): Promise<CheckinResponse> {
    const span = trace.getActiveSpan();
    span?.setAttributes({
      'lotou.show.id': scan.showId,
      'lotou.checkin.gate': scan.gate,
    });
    // O trace da requisição segue para o evento, pelo outbox; calculado aqui
    // porque o contexto ativo não sobrevive a todo callback do driver.
    const requestTrace = traceHeadersFrom(incoming, context.active());
    const now = new Date();

    const code = this.codes.verify(scan.code);
    if (!code.valid) {
      span?.setAttribute('lotou.checkin.code_problem', code.reason);
      return this.reject(scan, 'INVALID_CODE', null, requestTrace, now);
    }
    const { ticketId } = code;
    span?.setAttribute('lotou.ticket.id', ticketId);

    const ticket = await findScannedTicket(this.pool, ticketId);
    const evaluation = evaluate(ticket, scan.showId, now);
    if (!ticket || evaluation.result !== 'ELIGIBLE') {
      const reason =
        evaluation.result === 'ELIGIBLE' ? 'UNKNOWN_TICKET' : evaluation.result;
      return this.reject(scan, reason, ticket ?? null, requestTrace, now, {
        ticketId,
        entry: ticket?.entry,
      });
    }

    const entry: FirstEntry = { at: now, gate: scan.gate };
    const startsAt = ticket.show?.startsAt;
    const claim = await this.firstEntries.claim(ticketId, entry, startsAt);
    span?.setAttribute('lotou.checkin.redis', claim.outcome);
    if (claim.outcome === 'taken') {
      return this.reject(scan, 'ALREADY_USED', ticket, requestTrace, now, {
        ticketId,
        entry: claim.entry,
      });
    }

    let recorded: Recorded;
    try {
      recorded = await this.record(ticket, entry, requestTrace);
    } catch (error) {
      if (claim.outcome === 'claimed') {
        await this.firstEntries.release(ticketId, entry);
      }
      throw error;
    }

    switch (recorded.result) {
      case 'ACCEPTED':
        this.relay.notify();
        if (claim.outcome !== 'claimed') {
          // Redis fora, sem a chave ou com uma marca velha: fica com a verdade.
          await this.firstEntries.remember(ticketId, entry, startsAt);
        }
        this.finish(span, 'ACCEPTED');
        this.logger.log(
          `Ingresso ${ticketId} liberado no portão ${scan.gate} (show ${scan.showId})`,
        );
        return toResponse('ACCEPTED', ticket);
      case 'ALREADY_USED':
        if (recorded.entry) {
          await this.firstEntries.remember(ticketId, recorded.entry, startsAt);
        }
        return this.reject(scan, 'ALREADY_USED', ticket, requestTrace, now, {
          ticketId,
          entry: recorded.entry,
        });
      case 'CANCELLED':
        if (claim.outcome === 'claimed') {
          await this.firstEntries.release(ticketId, entry);
        }
        return this.reject(scan, 'CANCELLED', ticket, requestTrace, now, {
          ticketId,
        });
    }
  }

  /**
   * Grava a entrada e o `TicketCheckedIn`, juntos. Se outra transação gravou
   * a entrada primeiro (a constraint única recusa esta), devolve a dela; se
   * o ingresso foi cancelado no meio-tempo, desfaz tudo.
   */
  private async record(
    ticket: ScannedTicket,
    entry: FirstEntry,
    requestTrace: TraceHeaders,
  ): Promise<Recorded> {
    try {
      return await withTransaction(
        this.pool,
        async (client): Promise<Recorded> => {
          const inserted = await insertCheckin(client, {
            id: newId(),
            ticketId: ticket.ticketId,
            showId: ticket.showId,
            ...entry,
          });
          if (!inserted) {
            return {
              result: 'ALREADY_USED',
              entry: await findEntry(client, ticket.ticketId),
            };
          }
          if (!(await markUsed(client, ticket.ticketId))) {
            // Um TicketsCancelled chegou depois da consulta: desfaz a entrada.
            throw new CancelledMeanwhile();
          }
          await enqueue(client, {
            topic: TOPICS.checkinEvents,
            key: ticket.showId,
            event: ticketCheckedIn(ticket, entry.gate, entry.at),
            headers: requestTrace,
          });
          return { result: 'ACCEPTED' };
        },
      );
    } catch (error) {
      if (error instanceof CancelledMeanwhile) {
        return { result: 'CANCELLED' };
      }
      throw error;
    }
  }

  private reject(
    scan: Scan,
    reason: RejectionReason,
    ticket: ScannedTicket | null,
    requestTrace: TraceHeaders,
    now: Date,
    known: { ticketId: string; entry?: FirstEntry | null } | null = null,
  ): CheckinResponse {
    this.rejections.add(
      {
        id: newId(),
        showId: scan.showId,
        gate: scan.gate,
        reason,
        ticketId: known?.ticketId ?? null,
        rejectedAt: now,
      },
      requestTrace,
    );
    this.finish(trace.getActiveSpan(), reason);
    if (known) {
      this.logger.log(
        `Ingresso ${known.ticketId} recusado no portão ${scan.gate}: ${reason}`,
      );
    } else {
      this.logger.log(`Código inválido no portão ${scan.gate}`);
    }
    return toResponse(reason, ticket ?? undefined, known?.entry);
  }

  private finish(span: Span | undefined, result: CheckinResult): void {
    span?.setAttributes({
      'lotou.checkin.result': result,
      'lotou.checkin.color': RESULT_COLORS[result],
    });
  }
}
