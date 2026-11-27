import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { CheckinController } from './checkin.controller.js';
import { CheckinMetrics } from './checkin-metrics.js';
import { CheckinService } from './checkin.service.js';
import { FirstEntryStore } from './first-entry.store.js';
import { GateShowsService } from './gate-shows.service.js';
import { RejectionBuffer } from './rejection-buffer.js';

@Module({
  imports: [OutboxModule],
  controllers: [CheckinController],
  providers: [
    CheckinService,
    CheckinMetrics,
    FirstEntryStore,
    GateShowsService,
    RejectionBuffer,
  ],
  exports: [RejectionBuffer],
})
export class CheckinModule {}
