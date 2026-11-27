import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/authenticated-user.js';
import type { Page } from '../common/pagination/cursor.js';
import { CheckinMetrics } from './checkin-metrics.js';
import type { CheckinResponse } from './checkin-result.js';
import {
  type ListShowsQuery,
  listShowsQuerySchema,
  type ScanDto,
  scanSchema,
  showIdSchema,
} from './checkin.schemas.js';
import { CheckinService } from './checkin.service.js';
import {
  type GateShowResponse,
  GateShowsService,
  type SummaryResponse,
} from './gate-shows.service.js';

@Controller({ path: 'checkins', version: '1' })
export class CheckinController {
  constructor(
    private readonly checkins: CheckinService,
    private readonly shows: GateShowsService,
    private readonly metrics: CheckinMetrics,
  ) {}

  /**
   * Lê um QR code. Sempre `200` com o resultado, liberado ou não: para o
   * leitor, "já utilizado" ou "cancelado" é uma resposta, não um erro.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @Roles('gate-staff')
  async scan(
    @Body({ schema: scanSchema }) dto: ScanDto,
    @Headers('traceparent') traceparent?: string,
    @Headers('tracestate') tracestate?: string,
  ): Promise<CheckinResponse> {
    const startedAt = performance.now();
    const response = await this.checkins.scan(dto, {
      ...(traceparent && { traceparent }),
      ...(tracestate && { tracestate }),
    });
    this.metrics.record(
      dto.gate,
      response.result,
      (performance.now() - startedAt) / 1_000,
    );
    return response;
  }

  @Get('shows')
  @Roles('gate-staff')
  listShows(
    @Query({ schema: listShowsQuerySchema }) query: ListShowsQuery,
  ): Promise<Page<GateShowResponse>> {
    return this.shows.list(query.cursor, query.limit);
  }

  @Get('shows/:showId/summary')
  @Roles('gate-staff', 'producer')
  summary(
    @Param('showId', { schema: showIdSchema }) showId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SummaryResponse> {
    return this.shows.summary(showId, user);
  }
}
