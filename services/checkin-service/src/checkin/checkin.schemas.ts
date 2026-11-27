import { z } from 'zod';
import { idSchema } from '../common/ids.js';
import { cursorSchema, limitSchema } from '../common/pagination/cursor.js';

/**
 * Corpo do `POST /v1/checkins`. Só um corpo malformado é `400`: um código
 * qualquer (um QR de outro sistema, um texto, um ingresso falso) é uma leitura
 * válida e recebe `200` com `INVALID_CODE`.
 */
// O portão vira rótulo de métrica: curto e sem quebra de linha.
const gateSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{Cc}]+$/u, 'Portão com caractere de controle');

// Um QR code tem no máximo uns 3 KB; o código do Lotou tem até 130
// caracteres. Leitores que funcionam como teclado mandam um Enter no fim.
const codeSchema = z.string().trim().min(1).max(4_096);

export const scanSchema = z.object({
  showId: idSchema,
  gate: gateSchema,
  code: codeSchema,
});

export type ScanDto = z.infer<typeof scanSchema>;

export const showIdSchema = idSchema;

/** Leituras por envio: o aparelho manda a fila em lotes deste tamanho. */
export const MAX_OFFLINE_SCANS = 500;

/**
 * Corpo do `POST /v1/checkins/offline`: as leituras feitas sem internet. Um
 * código inválido ou um horário fora da janela não são `400`: viram `REJECTED`
 * na leitura, e o resto do lote é aceito.
 */
export const offlineSyncSchema = z.object({
  showId: idSchema,
  gate: gateSchema,
  /** UUID gerado uma vez e guardado no aparelho. */
  deviceId: idSchema,
  scans: z
    .array(
      z.object({
        /** Gerado no aparelho (UUID v7): reenviar a leitura não grava de novo. */
        id: idSchema,
        code: codeSchema,
        // ISO 8601 com fuso (`Z` ou `-03:00`), guardado em UTC.
        scannedAt: z.iso
          .datetime({ offset: true })
          .transform((value) => new Date(value)),
      }),
    )
    .min(1)
    .max(MAX_OFFLINE_SCANS),
});

export type OfflineSyncDto = z.infer<typeof offlineSyncSchema>;

export const listShowsQuerySchema = z.object({
  cursor: cursorSchema.optional(),
  limit: limitSchema,
});

export type ListShowsQuery = z.infer<typeof listShowsQuerySchema>;
