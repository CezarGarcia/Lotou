import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Public, Roles } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import { Idempotent } from '../common/idempotency/idempotency.interceptor.js';
import type { Page } from '../common/pagination/cursor.js';
import { RateLimited } from '../rate-limit/rate-limit.guard.js';
import { toVenueResponse, type VenueResponse } from './venue.response.js';
import {
  type CreateVenueDto,
  createVenueSchema,
  type ListVenuesQuery,
  listVenuesQuerySchema,
  type UpdateVenueDto,
  updateVenueSchema,
  venueIdSchema,
} from './venues.schemas.js';
import { VenuesService } from './venues.service.js';

@Controller({ path: 'venues', version: '1' })
export class VenuesController {
  constructor(private readonly venues: VenuesService) {}

  @Post()
  @Roles('producer')
  @Idempotent()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: createVenueSchema }) dto: CreateVenueDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VenueResponse> {
    const venue = await this.venues.create(user.id, dto);
    response.location(`/v1/venues/${venue._id}`);
    return toVenueResponse(venue);
  }

  @Get()
  @Public()
  @RateLimited()
  list(
    @Query({ schema: listVenuesQuerySchema }) query: ListVenuesQuery,
  ): Promise<Page<VenueResponse>> {
    return this.venues.list(query);
  }

  @Get(':id')
  @Public()
  @RateLimited()
  async get(
    @Param('id', { schema: venueIdSchema }) id: string,
  ): Promise<VenueResponse> {
    return toVenueResponse(await this.venues.getById(id));
  }

  @Patch(':id')
  @Roles('producer')
  async update(
    @Param('id', { schema: venueIdSchema }) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: updateVenueSchema }) dto: UpdateVenueDto,
  ): Promise<VenueResponse> {
    return toVenueResponse(await this.venues.update(id, user.id, dto));
  }
}
