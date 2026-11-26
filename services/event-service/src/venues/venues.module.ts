import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Show, ShowSchema } from '../shows/show.schema.js';
import { Venue, VenueSchema } from './venue.schema.js';
import { VenuesController } from './venues.controller.js';
import { VenuesService } from './venues.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Venue.name, schema: VenueSchema },
      { name: Show.name, schema: ShowSchema },
    ]),
  ],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService],
})
export class VenuesModule {}
