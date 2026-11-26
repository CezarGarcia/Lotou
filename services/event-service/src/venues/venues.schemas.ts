import { z } from 'zod';
import { idSchema } from '../common/ids/id.js';
import { cursorSchema, limitSchema } from '../common/pagination/cursor.js';
import { SECTOR_KINDS } from './sector-kind.js';

const isIanaTimezone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value.includes('/');
  } catch {
    return false;
  }
};

const name = z.string().trim().min(1).max(150);
const timezone = z
  .string()
  .refine(isIanaTimezone, 'Fuso IANA inválido (ex.: America/Sao_Paulo)');
const address = z.object({
  street: z.string().trim().min(1).max(200).optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().regex(/^[A-Z]{2}$/, 'Use a sigla da UF (ex.: SP)'),
});

const row = z.object({
  label: z.string().regex(/^[A-Z0-9]{1,4}$/, 'Use até 4 letras ou números'),
  seatCount: z.number().int().min(1).max(500),
});

const sector = z
  .object({
    /** Envie o ID para manter um setor existente; sem ID, o setor é novo. */
    id: idSchema.optional(),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(SECTOR_KINDS),
    capacity: z.number().int().min(1).max(500_000),
    /** Fileiras: obrigatórias em cadeira numerada, proibidas na pista. */
    rows: z.array(row).max(500).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'GENERAL_ADMISSION') {
      if (value.rows.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows'],
          message: 'Setor sem lugar marcado não tem fileiras',
        });
      }
      return;
    }
    const seats = value.rows.reduce((sum, r) => sum + r.seatCount, 0);
    if (seats !== value.capacity) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows'],
        message: `As fileiras somam ${seats} cadeiras, mas a capacidade é ${value.capacity}`,
      });
    }
    if (new Set(value.rows.map((r) => r.label)).size !== value.rows.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['rows'],
        message: 'As fileiras de um setor precisam ter rótulos diferentes',
      });
    }
  });

const sectors = z
  .array(sector)
  .min(1)
  .max(50)
  .refine(
    (items) =>
      new Set(items.map((s) => s.name.toLowerCase())).size === items.length,
    'Os setores de um local precisam ter nomes diferentes',
  );

export const createVenueSchema = z.object({ name, address, timezone, sectors });
export type CreateVenueDto = z.infer<typeof createVenueSchema>;

export const updateVenueSchema = z
  .object({ name, address, sectors })
  .partial()
  .extend({ version: z.number().int().positive() })
  .refine((dto) => Object.keys(dto).length > 1, 'Nada para alterar');
export type UpdateVenueDto = z.infer<typeof updateVenueSchema>;

// Estrito: um parâmetro desconhecido ou digitado errado é 400.
export const listVenuesQuerySchema = z.strictObject({
  limit: limitSchema,
  cursor: cursorSchema.optional(),
});
export type ListVenuesQuery = z.infer<typeof listVenuesQuerySchema>;

export const venueIdSchema = idSchema;
