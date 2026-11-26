import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { newId } from '../common/ids/id.js';
import { SECTOR_KINDS, type SectorKind } from '../venues/sector-kind.js';
import { type SeatRow, SeatRowSchema } from '../venues/venue.schema.js';
import { SHOW_STATUSES, type ShowStatus } from './show-status.js';

@Schema({ _id: false })
export class ShowLot {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ required: true })
  name: string;

  /** Preço em centavos, inteiro. Nunca ponto flutuante. */
  @Prop({ required: true, min: 0 })
  priceCents: number;

  /** Ingressos à venda neste lote. */
  @Prop({ required: true, min: 1 })
  quantity: number;

  /** Data em que o lote abre, se o produtor definiu; senão, quando o anterior esgota. */
  @Prop({ type: Date, default: null })
  opensAt: Date | null;
}
const ShowLotSchema = SchemaFactory.createForClass(ShowLot);

@Schema({ _id: false })
export class ShowSector {
  /** O mesmo ID do setor no local. */
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, required: true, enum: SECTOR_KINDS })
  kind: SectorKind;

  /** Capacidade do setor neste show; nunca acima da capacidade do local. */
  @Prop({ required: true, min: 1 })
  capacity: number;

  /** Fileiras copiadas do local (cadeira numerada); vazio na pista. */
  @Prop({ type: [SeatRowSchema], default: [] })
  rows: SeatRow[];

  /** Em ordem de virada: o próximo abre quando o atual esgota. */
  @Prop({ type: [ShowLotSchema], default: [] })
  lots: ShowLot[];
}
const ShowSectorSchema = SchemaFactory.createForClass(ShowSector);

/** Cópia dos dados do local usados na busca e na página do show. */
@Schema({ _id: false })
export class ShowVenue {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  city: string;

  @Prop({ required: true })
  state: string;

  @Prop({ required: true })
  timezone: string;

  /** Cidade sem acento e em minúsculas, para o filtro da busca. */
  @Prop({ required: true })
  citySearch: string;
}
const ShowVenueSchema = SchemaFactory.createForClass(ShowVenue);

// A coleção se chama `events`, como no modelo de dados do projeto.
@Schema({ collection: 'events', timestamps: true, versionKey: false })
export class Show {
  @Prop({ type: String, default: newId })
  _id: string;

  /** `sub` do produtor dono do show. */
  @Prop({ required: true })
  producerId: string;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  artist: string;

  /** Artista sem acento e em minúsculas, para a busca. */
  @Prop({ required: true })
  artistSearch: string;

  @Prop({ default: '' })
  description: string;

  @Prop({ type: String, required: true, enum: SHOW_STATUSES, default: 'DRAFT' })
  status: ShowStatus;

  /** Início do show, em UTC. */
  @Prop({ required: true })
  startsAt: Date;

  /**
   * Dia do show no fuso do local (`AAAA-MM-DD`). Um show às 22h de 31/12 em
   * São Paulo já é 1º/01 em UTC: o filtro por data usa este campo.
   */
  @Prop({ type: String, default: null })
  startsOn: string | null;

  /** Abertura dos portões: o check-in só é aceito a partir dela. */
  @Prop({ type: Date, default: null })
  doorsOpenAt: Date | null;

  @Prop({ type: Date, default: null })
  salesStartAt: Date | null;

  @Prop({ type: Date, default: null })
  salesEndAt: Date | null;

  /** Alta demanda: liga a fila virtual na abertura das vendas. */
  @Prop({ default: false })
  highDemand: boolean;

  @Prop({ type: ShowVenueSchema, default: null })
  venue: ShowVenue | null;

  @Prop({ type: [ShowSectorSchema], default: [] })
  sectors: ShowSector[];

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;

  /** Sobe a cada alteração; o cliente devolve a que leu (sem update perdido). */
  @Prop({ required: true, default: 1 })
  version: number;

  createdAt: Date;
  updatedAt: Date;
}

export const ShowSchema = SchemaFactory.createForClass(Show);

// Busca da loja: filtra por status, ordena por data, _id como desempate.
ShowSchema.index({ status: 1, startsAt: 1, _id: 1 });
// Busca por cidade.
ShowSchema.index({ 'venue.citySearch': 1, status: 1, startsAt: 1, _id: 1 });
// Shows de um local (propagação de nome e trava de edição dos setores).
ShowSchema.index({ 'venue.id': 1 });
// Leitura incremental do catálogo pelos outros serviços.
ShowSchema.index({ updatedAt: 1, _id: 1 });
