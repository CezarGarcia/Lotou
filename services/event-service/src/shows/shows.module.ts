import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VenuesModule } from '../venues/venues.module.js';
import { Show, ShowSchema } from './show.schema.js';
import { CatalogController } from './catalog.controller.js';
import { ShowLifecycleRunner } from './show-lifecycle.runner.js';
import { ShowsController } from './shows.controller.js';
import { ShowsService } from './shows.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Show.name, schema: ShowSchema }]),
    VenuesModule,
  ],
  controllers: [ShowsController, CatalogController],
  providers: [ShowsService, ShowLifecycleRunner],
})
export class ShowsModule {}
