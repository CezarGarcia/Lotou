import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
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
import {
  type ShowResponse,
  type ShowSummaryResponse,
  toShowResponse,
} from './show.response.js';
import {
  type CreateShowDto,
  createShowSchema,
  type SearchShowsQuery,
  searchShowsQuerySchema,
  showIdSchema,
  type UpdateShowDto,
  updateShowSchema,
} from './shows.schemas.js';
import { ShowsService } from './shows.service.js';

@Controller({ path: 'shows', version: '1' })
export class ShowsController {
  constructor(private readonly shows: ShowsService) {}

  @Post()
  @Roles('producer')
  @Idempotent()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: createShowSchema }) dto: CreateShowDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShowResponse> {
    const show = await this.shows.create(user.id, dto);
    response.location(`/v1/shows/${show._id}`);
    return toShowResponse(show);
  }

  @Get()
  @Public()
  search(
    @Query({ schema: searchShowsQuerySchema }) query: SearchShowsQuery,
  ): Promise<Page<ShowSummaryResponse>> {
    return this.shows.search(query);
  }

  @Get(':id')
  @Public()
  async get(
    @Param('id', { schema: showIdSchema }) id: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<ShowResponse> {
    return toShowResponse(await this.shows.getVisible(id, user));
  }

  @Patch(':id')
  @Roles('producer')
  async update(
    @Param('id', { schema: showIdSchema }) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body({ schema: updateShowSchema }) dto: UpdateShowDto,
  ): Promise<ShowResponse> {
    return toShowResponse(await this.shows.update(id, user.id, dto));
  }

  @Post(':id/publish')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  async publish(
    @Param('id', { schema: showIdSchema }) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ShowResponse> {
    return toShowResponse(await this.shows.publish(id, user.id));
  }
}
