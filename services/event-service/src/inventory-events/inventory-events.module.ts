import { Module } from '@nestjs/common';
import { ShowCacheModule } from '../shows/cache/show-cache.module.js';
import { InventoryEventsConsumer } from './inventory-events.consumer.js';

/** Eventos do inventory que mudam a página do show (Fluxo C). */
@Module({
  imports: [ShowCacheModule],
  providers: [InventoryEventsConsumer],
})
export class InventoryEventsModule {}
