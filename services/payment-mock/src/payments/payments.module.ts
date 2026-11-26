import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PaymentMetrics } from './payment-metrics.js';
import { PaymentsService } from './payments.service.js';
import {
  RANDOM_SOURCE,
  type RandomSource,
  SimulatedGateway,
} from './simulated-gateway.js';

@Module({
  imports: [OutboxModule],
  providers: [
    // Os testes trocam por uma sequência fixa, para forçar aprovação ou recusa.
    { provide: RANDOM_SOURCE, useValue: Math.random },
    {
      provide: SimulatedGateway,
      inject: [ConfigService, RANDOM_SOURCE],
      useFactory: (config: ConfigService<Env, true>, random: RandomSource) =>
        new SimulatedGateway(
          {
            declineRate: config.get('DECLINE_RATE', { infer: true }),
            refundFailureRate: config.get('REFUND_FAILURE_RATE', {
              infer: true,
            }),
            latencyMinMs: config.get('LATENCY_MIN_MS', { infer: true }),
            latencyMaxMs: config.get('LATENCY_MAX_MS', { infer: true }),
          },
          random,
        ),
    },
    PaymentMetrics,
    PaymentsService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
