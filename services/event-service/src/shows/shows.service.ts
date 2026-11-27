import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Connection, Model, QueryFilter } from 'mongoose';
import { type Page, toPage } from '../common/pagination/cursor.js';
import { ProblemException, Problems } from '../common/problem/problem.js';
import { escapeRegExp, normalizeText } from '../common/text/normalize.js';
import { Outbox } from '../outbox/outbox.js';
import { tracer } from '../telemetry/trace-context.js';
import type { Venue } from '../venues/venue.schema.js';
import { VenuesService } from '../venues/venues.service.js';
import { ShowPageCache } from './cache/show-page.cache.js';
import { catalogMessage } from './catalog-message.js';
import {
  buildSectors,
  localDate,
  publishViolations,
  scheduleViolations,
  type SectorInput,
} from './show-rules.js';
import {
  canTransition,
  EDITABLE_STATUSES,
  LISTED_STATUSES,
  type ShowStatus,
} from './show-status.js';
import { type ShowSummaryResponse, toShowSummary } from './show.response.js';
import { Show, type ShowSector, type ShowVenue } from './show.schema.js';
import type {
  CreateShowDto,
  SearchShowsQuery,
  UpdateShowDto,
} from './shows.schemas.js';

/** Valor novo se o cliente enviou o campo (mesmo `null`); senão, o atual. */
const changed = <T>(change: T | undefined, current: T): T =>
  change === undefined ? current : change;

const toShowVenue = (venue: Venue | null): ShowVenue | null =>
  venue && {
    id: venue._id,
    name: venue.name,
    city: venue.address.city,
    state: venue.address.state,
    timezone: venue.timezone,
    citySearch: normalizeText(venue.address.city),
  };

/**
 * A janela de vendas de um show publicado. Sem data de abertura, as vendas
 * abrem na publicação; sem data de encerramento, fecham no início do show.
 */
const salesWindow = (
  show: Pick<Show, 'salesStartAt' | 'salesEndAt' | 'startsAt'>,
  publishedAt: Date,
) => ({
  salesStartAt: show.salesStartAt ?? publishedAt,
  salesEndAt: show.salesEndAt ?? show.startsAt,
});

const toSectorInput = (sector: ShowSector): SectorInput => ({
  sectorId: sector.id,
  capacity: sector.capacity,
  lots: sector.lots,
});

@Injectable()
export class ShowsService {
  private readonly logger = new Logger(ShowsService.name);

  constructor(
    @InjectModel(Show.name) private readonly shows: Model<Show>,
    @InjectConnection() private readonly connection: Connection,
    private readonly venues: VenuesService,
    private readonly pageCache: ShowPageCache,
    private readonly outbox: Outbox,
  ) {}

  /** Cria o show como rascunho. Ele só aparece na loja depois de publicado. */
  async create(producerId: string, dto: CreateShowDto): Promise<Show> {
    const venue = await this.resolveVenue(dto.venueId ?? null);
    const schedule = {
      startsAt: dto.startsAt,
      doorsOpenAt: dto.doorsOpenAt ?? null,
      salesStartAt: dto.salesStartAt ?? null,
      salesEndAt: dto.salesEndAt ?? null,
    };
    const { sectors, violations } = buildSectors(dto.sectors, venue);
    violations.unshift(...scheduleViolations(schedule));
    if (violations.length > 0) {
      throw Problems.businessRule(violations);
    }

    const show = await this.shows.create({
      producerId,
      title: dto.title,
      artist: dto.artist,
      artistSearch: normalizeText(dto.artist),
      description: dto.description,
      ...schedule,
      startsOn: venue && localDate(dto.startsAt, venue.timezone),
      highDemand: dto.highDemand,
      serviceFeePaidBy: dto.serviceFeePaidBy,
      venue: toShowVenue(venue),
      sectors,
    });
    return show.toObject();
  }

  /** Busca da loja: só shows publicados, do mais próximo ao mais distante. */
  async search({
    artist,
    city,
    from,
    to,
    limit,
    cursor,
  }: SearchShowsQuery): Promise<Page<ShowSummaryResponse>> {
    // Montado campo a campo, com valores já validados: nenhum objeto da
    // requisição entra direto no filtro.
    const filter: QueryFilter<Show> = { status: { $in: LISTED_STATUSES } };
    const and: QueryFilter<Show>[] = [];

    if (artist) {
      // Contém o termo, sem acento e sem caixa. Não usa índice; a coleção de
      // shows é pequena. Autocomplete com um motor de busca é fase extra.
      filter.artistSearch = { $regex: escapeRegExp(normalizeText(artist)) };
    }
    if (city) {
      filter['venue.citySearch'] = normalizeText(city);
    }
    if (from || to) {
      filter.startsOn = {
        ...(from && { $gte: from }),
        ...(to && { $lte: to }),
      };
    } else {
      // Sem período, a loja mostra só o que ainda vai acontecer.
      and.push({ startsAt: { $gte: new Date() } });
    }
    if (cursor) {
      // Depois do cursor na ordem (startsAt, _id).
      const startsAt = new Date(cursor.sortValue);
      and.push({
        $or: [
          { startsAt: { $gt: startsAt } },
          { startsAt, _id: { $gt: cursor.id } },
        ],
      });
    }
    if (and.length > 0) {
      filter.$and = and;
    }

    // Um a mais que a página: se vier, existe próxima página.
    const found = await this.shows
      .find(filter)
      .sort({ startsAt: 1, _id: 1 })
      .limit(limit + 1)
      .lean();
    return toPage(
      found,
      limit,
      (show) => ({ sortValue: show.startsAt.getTime(), id: show._id }),
      toShowSummary,
    );
  }

  async update(
    id: string,
    producerId: string,
    { version, ...changes }: UpdateShowDto,
  ): Promise<Show> {
    const current = await this.getOwned(id, producerId);
    if (!EDITABLE_STATUSES.includes(current.status)) {
      throw new ProblemException({
        status: HttpStatus.CONFLICT,
        slug: 'show-not-editable',
        title: 'Show não pode ser editado',
        detail: `Um show em ${current.status} não pode mais ser editado.`,
      });
    }

    const currentVenueId = current.venue?.id ?? null;
    const venueId = changed(changes.venueId, currentVenueId);
    const venueChanged = venueId !== currentVenueId;
    const venue = await this.resolveVenue(venueId);

    const schedule = {
      startsAt: changed(changes.startsAt, current.startsAt),
      doorsOpenAt: changed(changes.doorsOpenAt, current.doorsOpenAt),
      salesStartAt: changed(changes.salesStartAt, current.salesStartAt),
      salesEndAt: changed(changes.salesEndAt, current.salesEndAt),
    };
    const violations = scheduleViolations(schedule);

    // Os setores são revalidados quando o cliente os envia ou quando o local
    // muda (os setores atuais podem não existir no local novo).
    let sectors = current.sectors;
    const sectorInputs =
      changes.sectors ??
      (venueChanged ? current.sectors.map(toSectorInput) : undefined);
    if (sectorInputs) {
      const built = buildSectors(sectorInputs, venue, current.sectors);
      sectors = built.sectors;
      violations.push(...built.violations);
    }

    const artist = changed(changes.artist, current.artist);
    const next = {
      title: changed(changes.title, current.title),
      artist,
      artistSearch: normalizeText(artist),
      description: changed(changes.description, current.description),
      ...schedule,
      startsOn: venue && localDate(schedule.startsAt, venue.timezone),
      highDemand: changed(changes.highDemand, current.highDemand),
      serviceFeePaidBy: changed(
        changes.serviceFeePaidBy,
        current.serviceFeePaidBy ?? 'BUYER',
      ),
      venue: venueChanged ? toShowVenue(venue) : current.venue,
      sectors,
    };

    // Um show publicado não pode voltar a um estado que não seria publicável,
    // e continua com a janela de vendas definida.
    if (current.status === 'PUBLISHED') {
      violations.push(...publishViolations(next));
      Object.assign(next, salesWindow(next, current.publishedAt ?? new Date()));
    }
    if (violations.length > 0) {
      throw Problems.businessRule(violations);
    }

    // Uma única operação condicional: só altera se o show ainda estiver na
    // versão e no estado que o cliente leu. Fora do rascunho, a mudança vai
    // para o catálogo na mesma transação.
    const updated = await this.connection.transaction(async (session) => {
      const show = await this.shows
        .findOneAndUpdate(
          { _id: id, version, status: current.status },
          { $set: next, $inc: { version: 1 } },
          { returnDocument: 'after', session },
        )
        .lean();
      if (!show) {
        versionConflict();
      }
      if (show.status !== 'DRAFT') {
        await this.outbox.append(
          [catalogMessage('ShowUpdated', show)],
          session,
        );
      }
      return show;
    });
    await this.pageCache.evict([id]);
    return updated;
  }

  /**
   * PUBLISHED ou ON_SALE -> CANCELLED, pelo produtor. O `ShowUpdated` com o
   * status novo sai na mesma transação; o order-service o lê e reembolsa todos
   * os pedidos confirmados, com controle de vazão.
   */
  async cancel(id: string, producerId: string): Promise<Show> {
    const current = await this.getOwned(id, producerId);
    this.assertTransition(current, 'CANCELLED');
    const cancelled = await this.connection.transaction(async (session) => {
      const show = await this.shows
        .findOneAndUpdate(
          { _id: id, version: current.version, status: current.status },
          { $set: { status: 'CANCELLED' }, $inc: { version: 1 } },
          { returnDocument: 'after', session },
        )
        .lean();
      if (!show) {
        versionConflict();
      }
      await this.outbox.append([catalogMessage('ShowUpdated', show)], session);
      return show;
    });
    await this.pageCache.evict([id]);
    return cancelled;
  }

  /** DRAFT -> PUBLISHED: exige local, ao menos um setor e ao menos um lote. */
  async publish(id: string, producerId: string): Promise<Show> {
    const current = await this.getOwned(id, producerId);
    this.assertTransition(current, 'PUBLISHED');

    const violations = publishViolations(current);
    if (violations.length > 0) {
      throw new ProblemException({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        slug: 'show-not-publishable',
        title: 'Show não pode ser publicado',
        detail: 'Falta configurar o show antes de publicar.',
        errors: violations,
      });
    }

    // O show e a mensagem `ShowPublished` entram juntos, ou nenhum entra.
    const publishedAt = new Date();
    const published = await this.connection.transaction(async (session) => {
      const show = await this.shows
        .findOneAndUpdate(
          { _id: id, version: current.version, status: current.status },
          {
            $set: {
              status: 'PUBLISHED',
              publishedAt,
              ...salesWindow(current, publishedAt),
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', session },
        )
        .lean();
      if (!show) {
        versionConflict();
      }
      await this.outbox.append(
        [catalogMessage('ShowPublished', show)],
        session,
      );
      return show;
    });
    await this.pageCache.evict([id]);
    return published;
  }

  /**
   * Avança os shows cujo horário chegou: PUBLISHED -> ON_SALE na abertura das
   * vendas e ON_SALE -> SALES_CLOSED no encerramento.
   *
   * Cada show avança na sua própria transação, com um update condicional e a
   * mensagem `ShowUpdated` no outbox. Pode rodar em várias instâncias ao
   * mesmo tempo sem lock: a condição se repete no update, então só uma delas
   * altera cada show (a outra recebe um conflito de escrita, repete a
   * transação e não encontra mais o show no estado de origem). Os candidatos
   * saem do cache da página; a instância que perdeu a corrida também os tira,
   * o que não faz mal.
   */
  async advanceLifecycle(now: Date = new Date()): Promise<number> {
    const steps = [
      { from: 'PUBLISHED', to: 'ON_SALE', when: 'salesStartAt' },
      { from: 'ON_SALE', to: 'SALES_CLOSED', when: 'salesEndAt' },
    ] as const;

    let advanced = 0;
    for (const { from, to, when } of steps) {
      if (!canTransition(from, to)) {
        throw new Error(`Transição fora da tabela: ${from} -> ${to}`);
      }
      const due: QueryFilter<Show> = { status: from, [when]: { $lte: now } };
      const ids = await this.shows.distinct('_id', due);
      if (ids.length === 0) {
        continue;
      }
      const count = await this.advance(ids, due, to);
      await this.pageCache.evict(ids);
      if (count > 0) {
        this.logger.log({ msg: 'Shows avançaram de estado', from, to, count });
      }
      advanced += count;
    }
    return advanced;
  }

  /**
   * Avança os candidatos de um passo. Roda num span próprio, só quando há
   * candidatos (o job roda a cada segundo), para as mensagens no catálogo
   * terem um trace de origem.
   */
  private advance(
    ids: string[],
    due: QueryFilter<Show>,
    to: ShowStatus,
  ): Promise<number> {
    return tracer.startActiveSpan(
      `show-lifecycle ${to}`,
      { attributes: { 'lotou.shows.candidates': ids.length } },
      async (span) => {
        try {
          let count = 0;
          for (const id of ids) {
            const show = await this.connection.transaction(async (session) => {
              const changed = await this.shows
                .findOneAndUpdate(
                  { ...due, _id: id },
                  { $set: { status: to }, $inc: { version: 1 } },
                  { returnDocument: 'after', session },
                )
                .lean();
              if (changed) {
                await this.outbox.append(
                  [catalogMessage('ShowUpdated', changed)],
                  session,
                );
              }
              return changed;
            });
            if (show) {
              count += 1;
            }
          }
          span.setAttribute('lotou.shows.advanced', count);
          return count;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /** Recusa, e registra em log, a transição que não está na tabela. */
  private assertTransition(show: Show, to: ShowStatus): void {
    if (canTransition(show.status, to)) {
      return;
    }
    this.logger.warn({
      msg: 'Transição de estado recusada',
      showId: show._id,
      from: show.status,
      to,
    });
    throw new ProblemException({
      status: HttpStatus.CONFLICT,
      slug: 'invalid-state-transition',
      title: 'Transição de estado inválida',
      detail: `Um show em ${show.status} não pode ir para ${to}.`,
    });
  }

  /** O show, se for deste produtor. Show de outro produtor é 404, não 403. */
  private async getOwned(id: string, producerId: string): Promise<Show> {
    const show = await this.shows.findOne({ _id: id, producerId }).lean();
    return show ?? notFound();
  }

  private async resolveVenue(venueId: string | null): Promise<Venue | null> {
    if (!venueId) {
      return null;
    }
    const venue = await this.venues.findById(venueId);
    if (!venue) {
      throw Problems.businessRule([
        { field: 'venueId', message: 'Local não encontrado' },
      ]);
    }
    return venue;
  }
}

function notFound(): never {
  throw Problems.notFound('Show');
}

function versionConflict(): never {
  throw Problems.versionConflict('O show');
}
