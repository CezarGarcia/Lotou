import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Connection, Model, QueryFilter } from 'mongoose';
import { newId } from '../common/ids/id.js';
import { type Page, toPage } from '../common/pagination/cursor.js';
import { ProblemException, Problems } from '../common/problem/problem.js';
import { normalizeText } from '../common/text/normalize.js';
import { Outbox } from '../outbox/outbox.js';
import { ShowPageCache } from '../shows/cache/show-page.cache.js';
import { catalogMessage } from '../shows/catalog-message.js';
import { Show } from '../shows/show.schema.js';
import { Venue } from './venue.schema.js';
import { toVenueResponse, type VenueResponse } from './venue.response.js';
import type {
  CreateVenueDto,
  ListVenuesQuery,
  UpdateVenueDto,
} from './venues.schemas.js';

@Injectable()
export class VenuesService {
  constructor(
    @InjectModel(Venue.name) private readonly venues: Model<Venue>,
    // Os shows guardam uma cópia de nome e cidade do local (para a busca), e
    // o local não pode mudar de setores enquanto um show depende deles.
    @InjectModel(Show.name) private readonly shows: Model<Show>,
    @InjectConnection() private readonly connection: Connection,
    private readonly showPageCache: ShowPageCache,
    private readonly outbox: Outbox,
  ) {}

  async create(producerId: string, dto: CreateVenueDto): Promise<Venue> {
    const venue = await this.venues.create({
      ...dto,
      sectors: dto.sectors.map((sector) => ({ ...sector, id: newId() })),
      createdBy: producerId,
    });
    return venue.toObject();
  }

  async findById(id: string): Promise<Venue | null> {
    return this.venues.findById(id).lean();
  }

  async getById(id: string): Promise<Venue> {
    return (await this.findById(id)) ?? notFound();
  }

  async list({ limit, cursor }: ListVenuesQuery): Promise<Page<VenueResponse>> {
    const filter: QueryFilter<Venue> = {};
    if (cursor) {
      const createdAt = new Date(cursor.sortValue);
      filter.$or = [
        { createdAt: { $lt: createdAt } },
        { createdAt, _id: { $lt: cursor.id } },
      ];
    }
    const found = await this.venues
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    return toPage(
      found,
      limit,
      (venue) => ({ sortValue: venue.createdAt.getTime(), id: venue._id }),
      toVenueResponse,
    );
  }

  async update(
    id: string,
    producerId: string,
    { version, ...changes }: UpdateVenueDto,
  ): Promise<Venue> {
    const current = await this.getById(id);
    if (current.createdBy !== producerId) {
      throw Problems.forbidden();
    }

    const set: Partial<Venue> = {};
    if (changes.name !== undefined) {
      set.name = changes.name;
    }
    if (changes.address !== undefined) {
      set.address = changes.address;
    }
    if (changes.sectors !== undefined) {
      if (await this.shows.exists({ 'venue.id': id })) {
        throw new ProblemException({
          status: HttpStatus.CONFLICT,
          slug: 'venue-in-use',
          title: 'Local em uso',
          detail:
            'Os setores não podem mudar enquanto houver shows neste local.',
        });
      }
      const known = new Set(current.sectors.map((sector) => sector.id));
      const unknown = changes.sectors.findIndex(
        (sector) => sector.id !== undefined && !known.has(sector.id),
      );
      if (unknown >= 0) {
        throw Problems.businessRule([
          {
            field: `sectors.${unknown}.id`,
            message: 'Este setor não existe no local',
          },
        ]);
      }
      set.sectors = changes.sectors.map((sector) => ({
        ...sector,
        id: sector.id ?? newId(),
      }));
    }

    // Uma única operação condicional: só altera se o local ainda estiver na
    // versão que o cliente leu. Os shows do local mudam na mesma transação.
    const { venue, showIds } = await this.connection.transaction(
      async (session) => {
        const venue = await this.venues
          .findOneAndUpdate(
            { _id: id, version },
            { $set: set, $inc: { version: 1 } },
            { returnDocument: 'after', session },
          )
          .lean();
        if (!venue) {
          throw Problems.versionConflict('O local');
        }
        const showIds =
          set.name !== undefined || set.address !== undefined
            ? await this.copyToShows(venue, session)
            : [];
        return { venue, showIds };
      },
    );
    // Todo show que recebeu o nome novo sai do cache. Um show que entrar no
    // local depois disso já lê o local atual.
    await this.showPageCache.evict(showIds);
    return venue;
  }

  /**
   * Copia nome e endereço do local para os shows dele. Cada show muda de
   * versão, e os que já saíram do rascunho vão para o catálogo como
   * `ShowUpdated`. Devolve os IDs dos shows alterados.
   */
  private async copyToShows(
    venue: Venue,
    session: ClientSession,
  ): Promise<string[]> {
    const filter = { 'venue.id': venue._id };
    await this.shows.updateMany(
      filter,
      {
        $set: {
          'venue.name': venue.name,
          'venue.city': venue.address.city,
          'venue.state': venue.address.state,
          'venue.citySearch': normalizeText(venue.address.city),
        },
        $inc: { version: 1 },
      },
      { session },
    );
    const changed = await this.shows.find(filter).session(session).lean();
    await this.outbox.append(
      changed
        .filter((show) => show.status !== 'DRAFT')
        .map((show) => catalogMessage('ShowUpdated', show)),
      session,
    );
    return changed.map((show) => show._id);
  }
}

function notFound(): never {
  throw Problems.notFound('Local');
}
