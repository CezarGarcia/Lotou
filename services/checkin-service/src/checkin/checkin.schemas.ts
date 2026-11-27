import { z } from 'zod';
import { idSchema } from '../common/ids.js';
import { cursorSchema, limitSchema } from '../common/pagination/cursor.js';

/**
 * Corpo do `POST /v1/checkins`. Só um corpo malformado é `400`: um código
 * qualquer (um QR de outro sistema, um texto, um ingresso falso) é uma leitura
 * válida e recebe `200` com `INVALID_CODE`.
 */
export const scanSchema = z.object({
  showId: idSchema,
  // O portão vira rótulo de métrica: curto e sem quebra de linha.
  gate: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[^\p{Cc}]+$/u, 'Portão com caractere de controle'),
  // Um QR code tem no máximo uns 3 KB; o código do Lotou tem 87 caracteres.
  // Leitores que funcionam como teclado mandam um Enter no fim.
  code: z.string().trim().min(1).max(4_096),
});

export type ScanDto = z.infer<typeof scanSchema>;

export const showIdSchema = idSchema;

export const listShowsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: limitSchema,
});

export type ListShowsQuery = z.infer<typeof listShowsQuerySchema>;
