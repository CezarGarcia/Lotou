import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { newId } from '../common/ids/id.js';
import { SECTOR_KINDS, type SectorKind } from './sector-kind.js';

@Schema({ _id: false })
export class VenueSector {
  @Prop({ type: String, required: true })
  id: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, required: true, enum: SECTOR_KINDS })
  kind: SectorKind;

  /** Capacidade física do setor: o teto de qualquer show neste local. */
  @Prop({ required: true, min: 1 })
  capacity: number;
}
const VenueSectorSchema = SchemaFactory.createForClass(VenueSector);

@Schema({ _id: false })
export class VenueAddress {
  @Prop({ type: String })
  street?: string;

  @Prop({ required: true })
  city: string;

  /** UF, ex.: `SP`. */
  @Prop({ required: true })
  state: string;
}
const VenueAddressSchema = SchemaFactory.createForClass(VenueAddress);

@Schema({ collection: 'venues', timestamps: true, versionKey: false })
export class Venue {
  @Prop({ type: String, default: newId })
  _id: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: VenueAddressSchema, required: true })
  address: VenueAddress;

  /**
   * Fuso IANA do local, ex.: `America/Sao_Paulo`. As datas são gravadas em
   * UTC e exibidas neste fuso. Não muda depois de criado.
   */
  @Prop({ required: true })
  timezone: string;

  @Prop({ type: [VenueSectorSchema], required: true })
  sectors: VenueSector[];

  /** `sub` do produtor que cadastrou o local; só ele pode editar. */
  @Prop({ required: true })
  createdBy: string;

  /** Sobe a cada alteração; o cliente devolve a que leu (sem update perdido). */
  @Prop({ required: true, default: 1 })
  version: number;

  createdAt: Date;
  updatedAt: Date;
}

export const VenueSchema = SchemaFactory.createForClass(Venue);

// Ordem da listagem, com _id no fim como desempate.
VenueSchema.index({ createdAt: -1, _id: -1 });
