import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { VenuesModule } from '../venues/venues.module.js';
import { Show, ShowSchema } from './show.schema.js';
import { ShowsController } from './shows.controller.js';
import { ShowsService } from './shows.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Show.name, schema: ShowSchema }]),
    VenuesModule,
  ],
  controllers: [ShowsController],
  providers: [ShowsService],
})
export class ShowsModule {}
