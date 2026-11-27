import {
  Body,
  Controller,
  Get,
  Header,
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
import { RateLimited } from '../rate-limit/rate-limit.guard.js';
import { ShowPageCache } from './cache/show-page.cache.js';
import { ShowSearchCache } from './cache/show-search.cache.js';
import { type ShowResponse, toShowResponse } from './show.response.js';
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

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

@Controller({ path: 'shows', version: '1' })
export class ShowsController {
  constructor(
    private readonly shows: ShowsService,
    private readonly pageCache: ShowPageCache,
    private readonly searchCache: ShowSearchCache,
  ) {}

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

  // As duas leituras devolvem o JSON pronto, como está no cache: sem parse e
  // nova serialização a cada acerto. O contrato é `Page<ShowSummaryResponse>`
  // na busca e `ShowResponse` na página do show.
  @Get()
  @Public()
  @RateLimited()
  @Header('Content-Type', JSON_CONTENT_TYPE)
  search(
    @Query({ schema: searchShowsQuerySchema }) query: SearchShowsQuery,
  ): Promise<string> {
    return this.searchCache.get(query, () => this.shows.search(query));
  }

  @Get(':id')
  @Public()
  @RateLimited()
  @Header('Content-Type', JSON_CONTENT_TYPE)
  get(
    @Param('id', { schema: showIdSchema }) id: string,
    @CurrentUser() user: AuthenticatedUser | undefined,
  ): Promise<string> {
    return this.pageCache.get(id, user);
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

  /** O produtor cancela o show: os pedidos confirmados são reembolsados. */
  @Post(':id/cancel')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id', { schema: showIdSchema }) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ShowResponse> {
    return toShowResponse(await this.shows.cancel(id, user.id));
  }
}
