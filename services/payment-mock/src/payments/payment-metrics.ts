import { Injectable } from '@nestjs/common';
import { type Counter, metrics } from '@opentelemetry/api';
import type { PaymentResult } from './payment-plan.js';

/**
 * `payments_total{result}`: decisões tomadas pelo gateway simulado
 * (`authorized`, `declined`, `refunded`, `refund_failed`). Uma resposta
 * repetida não conta: nada foi decidido de novo. Usa a API do OpenTelemetry;
 * sem o SDK (testes), não faz nada.
 */
@Injectable()
export class PaymentMetrics {
  private readonly payments: Counter = metrics
    .getMeter('lotou.payment-mock')
    .createCounter('payments_total', {
      description: 'Pagamentos e estornos decididos, por resultado',
    });

  record(result: PaymentResult): void {
    this.payments.add(1, { result });
  }
}
