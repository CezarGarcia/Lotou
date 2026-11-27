import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { CheckinController } from './checkin.controller.js';
import { CheckinMetrics } from './checkin-metrics.js';
import { CheckinService } from './checkin.service.js';
import { FirstEntryStore } from './first-entry.store.js';
import { GateShowsService } from './gate-shows.service.js';
import { OfflineController } from './offline.controller.js';
import { OfflineService } from './offline.service.js';
import { RejectionBuffer } from './rejection-buffer.js';
import { TicketCodeVerifier } from './ticket-code.js';

@Module({
  imports: [OutboxModule],
  controllers: [CheckinController, OfflineController],
  providers: [
    CheckinService,
    CheckinMetrics,
    FirstEntryStore,
    GateShowsService,
    OfflineService,
    RejectionBuffer,
    {
      // As chaves do QR: o HMAC do `LOTOU1` e a pública do `LOTOU2` (ADR 38).
      provide: TicketCodeVerifier,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new TicketCodeVerifier({
          hmacKey: config.get('TICKET_QR_KEY', { infer: true }),
          publicKey: config.get('TICKET_PUBLIC_KEY', { infer: true }),
        }),
    },
  ],
  exports: [RejectionBuffer],
})
export class CheckinModule {}
