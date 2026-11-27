import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { Roles } from '../auth/auth.decorators.js';
import {
  type OfflineSyncDto,
  offlineSyncSchema,
  showIdSchema,
} from './checkin.schemas.js';
import type { OfflineScanResult } from './offline-scan.js';
import { type OfflinePackage, OfflineService } from './offline.service.js';

/** A portaria sem internet (ADR 38): o pacote do show e o envio das leituras. */
@Controller({ path: 'checkins', version: '1' })
export class OfflineController {
  constructor(private readonly offline: OfflineService) {}

  /** O que o leitor guarda no aparelho para validar sem internet. */
  @Get('shows/:showId/offline-package')
  @Roles('gate-staff')
  offlinePackage(
    @Param('showId', { schema: showIdSchema }) showId: string,
  ): Promise<OfflinePackage> {
    return this.offline.offlinePackage(showId);
  }

  /**
   * As leituras feitas sem internet. Sempre `200`, com o resultado de cada
   * uma; idempotente pelo `id` de cada leitura, por isso sem `Idempotency-Key`.
   */
  @Post('offline')
  @HttpCode(HttpStatus.OK)
  @Roles('gate-staff')
  sync(
    @Body({ schema: offlineSyncSchema }) dto: OfflineSyncDto,
    @Headers('traceparent') traceparent?: string,
    @Headers('tracestate') tracestate?: string,
  ): Promise<{ results: OfflineScanResult[] }> {
    return this.offline.sync(dto, {
      ...(traceparent && { traceparent }),
      ...(tracestate && { tracestate }),
    });
  }
}
