import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OutboxModule } from '../outbox/outbox.module.js';
import { VenuesModule } from '../venues/venues.module.js';
import { ShowCacheModule } from './cache/show-cache.module.js';
import { Show, ShowSchema } from './show.schema.js';
import { ShowLifecycleRunner } from './show-lifecycle.runner.js';
import { ShowsController } from './shows.controller.js';
import { ShowsService } from './shows.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Show.name, schema: ShowSchema }]),
    VenuesModule,
    ShowCacheModule,
    OutboxModule,
  ],
  controllers: [ShowsController],
  providers: [ShowsService, ShowLifecycleRunner],
})
export class ShowsModule {}
