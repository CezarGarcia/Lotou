import { Controller, Get, Query, VERSION_NEUTRAL } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators.js';
import type { Page } from '../common/pagination/cursor.js';
import type { SectorKind } from '../venues/sector-kind.js';
import type { ShowStatus } from './show-status.js';
import type { Show } from './show.schema.js';
import { type CatalogQuery, catalogQuerySchema } from './shows.schemas.js';
import { ShowsService } from './shows.service.js';

/** O show como os outros serviços precisam: o que define estoque e vendas. */
export interface CatalogShow {
  id: string;
  producerId: string;
  status: ShowStatus;
  /** Sobe a cada alteração: quem consome ignora uma versão mais antiga. */
  version: number;
  updatedAt: Date;
  startsAt: Date;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
  highDemand: boolean;
  sectors: {
    id: string;
    name: string;
    kind: SectorKind;
    capacity: number;
    rows: { label: string; seatCount: number }[];
    lots: {
      id: string;
      name: string;
      priceCents: number;
      quantity: number;
      opensAt: Date | null;
    }[];
  }[];
}

const toCatalogShow = (show: Show): CatalogShow => ({
  id: show._id,
  producerId: show.producerId,
  status: show.status,
  version: show.version,
  updatedAt: show.updatedAt,
  startsAt: show.startsAt,
  salesStartAt: show.salesStartAt,
  salesEndAt: show.salesEndAt,
  highDemand: show.highDemand,
  sectors: show.sectors.map((sector) => ({
    id: sector.id,
    name: sector.name,
    kind: sector.kind,
    capacity: sector.capacity,
    rows: (sector.rows ?? []).map(({ label, seatCount }) => ({
      label,
      seatCount,
    })),
    lots: sector.lots.map(({ id, name, priceCents, quantity, opensAt }) => ({
      id,
      name,
      priceCents,
      quantity,
      opensAt,
    })),
  })),
});

/**
 * API interna: catálogo de shows para os outros serviços do Lotou. Não passa
 * pelo gateway e exige o papel `service` (conta de serviço).
 *
 * Na fase 1 o inventory-service lê o catálogo daqui, por polling. Na fase 3
 * isso vira o tópico `shows.catalog` no Kafka (ADR 23).
 */
@Controller({ path: 'internal/v1/catalog/shows', version: VERSION_NEUTRAL })
@Roles('service')
export class CatalogController {
  constructor(private readonly shows: ShowsService) {}

  @Get()
  async list(
    @Query({ schema: catalogQuerySchema }) query: CatalogQuery,
  ): Promise<Page<CatalogShow>> {
    const page = await this.shows.listCatalog(query);
    return {
      items: page.items.map(toCatalogShow),
      nextCursor: page.nextCursor,
    };
  }
}
