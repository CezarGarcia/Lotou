import { z } from 'zod';
import { idSchema } from '../common/ids/id.js';
import { cursorSchema, limitSchema } from '../common/pagination/cursor.js';
import { SERVICE_FEE_PAYERS } from './show.schema.js';

// Data e hora com fuso explícito (Z ou offset): sem fuso, o instante é ambíguo.
const instant = z.iso
  .datetime({
    offset: true,
    error: 'Use ISO 8601 com fuso (ex.: 2027-03-20T20:00:00-03:00)',
  })
  .transform((value) => new Date(value));

const title = z.string().trim().min(1).max(150);
const artist = z.string().trim().min(1).max(150);
const description = z.string().trim().max(5_000);

const lot = z.object({
  /** Envie o ID para manter um lote existente; sem ID, o lote é novo. */
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(80),
  // Centavos, inteiro. O teto (R$ 1 milhão) só barra erro de digitação.
  priceCents: z.number().int().min(0).max(100_000_000),
  quantity: z.number().int().min(1).max(500_000),
  opensAt: instant.nullish(),
});

const sector = z.object({
  /** ID do setor no local do show. */
  sectorId: idSchema,
  /** Padrão: a capacidade do setor no local. */
  capacity: z.number().int().min(1).max(500_000).optional(),
  lots: z.array(lot).max(20).default([]),
});

const sectors = z.array(sector).max(50);

export const createShowSchema = z.object({
  title,
  artist,
  description: description.default(''),
  startsAt: instant,
  doorsOpenAt: instant.nullish(),
  salesStartAt: instant.nullish(),
  salesEndAt: instant.nullish(),
  highDemand: z.boolean().default(false),
  serviceFeePaidBy: z.enum(SERVICE_FEE_PAYERS).default('BUYER'),
  venueId: idSchema.nullish(),
  sectors: sectors.default([]),
});
export type CreateShowDto = z.infer<typeof createShowSchema>;

// Tudo opcional, mais a versão que o cliente leu. `null` limpa o campo;
// campo ausente fica como está. `sectors` substitui a lista inteira.
export const updateShowSchema = z
  .object({
    title,
    artist,
    description,
    startsAt: instant,
    doorsOpenAt: instant.nullable(),
    salesStartAt: instant.nullable(),
    salesEndAt: instant.nullable(),
    highDemand: z.boolean(),
    serviceFeePaidBy: z.enum(SERVICE_FEE_PAYERS),
    venueId: idSchema.nullable(),
    sectors,
  })
  .partial()
  .extend({ version: z.number().int().positive() })
  .refine((dto) => Object.keys(dto).length > 1, 'Nada para alterar');
export type UpdateShowDto = z.infer<typeof updateShowSchema>;

const day = z.iso.date('Use AAAA-MM-DD');

// Estrito: um parâmetro desconhecido ou digitado errado é 400, não uma lista
// sem filtro.
export const searchShowsQuerySchema = z
  .strictObject({
    artist: z.string().trim().min(1).max(100).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    /** Dia inicial e final, no fuso do local de cada show. */
    from: day.optional(),
    to: day.optional(),
    limit: limitSchema,
    cursor: cursorSchema.optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ['to'],
    message: 'A data final precisa ser igual ou posterior à inicial',
  });
export type SearchShowsQuery = z.infer<typeof searchShowsQuerySchema>;

export const showIdSchema = idSchema;
