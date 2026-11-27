import { z } from 'zod';
import { idSchema } from '../ids.js';

/**
 * Paginação por cursor. O cursor guarda o valor de ordenação e o ID do último
 * item da página; a página seguinte começa logo depois dele. Diferente de
 * `skip`, não fica mais lento em páginas fundas nem repete itens quando um
 * registro novo entra no meio da leitura.
 */
export interface Page<T> {
  items: T[];
  /** Devolva em `cursor` para ler a próxima página; `null` na última. */
  nextCursor: string | null;
}

export interface CursorPosition {
  /** Valor de ordenação do último item, em milissegundos desde a época. */
  sortValue: number;
  id: string;
}

export function encodeCursor({ sortValue, id }: CursorPosition): string {
  return Buffer.from(JSON.stringify([sortValue, id]), 'utf8').toString(
    'base64url',
  );
}

/**
 * O cursor é opaco para o cliente, mas continua sendo entrada do cliente: é
 * decodificado e validado antes de chegar a um filtro do banco.
 */
export const cursorSchema = z
  .base64url()
  .max(200)
  .transform((value, ctx) => {
    try {
      return JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Cursor inválido' });
      return z.NEVER;
    }
  })
  .pipe(
    z.tuple([z.number().int().min(0).max(8.64e15), idSchema], {
      error: 'Cursor inválido',
    }),
  )
  .transform(([sortValue, id]): CursorPosition => ({ sortValue, id }));

export const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

/**
 * Monta a página a partir de `limit + 1` itens lidos: se o item extra veio,
 * existe próxima página.
 */
export function toPage<T, R>(
  found: T[],
  limit: number,
  position: (item: T) => CursorPosition,
  map: (item: T) => R,
): Page<R> {
  const items = found.slice(0, limit);
  const last = items.at(-1);
  return {
    items: items.map(map),
    nextCursor:
      found.length > limit && last ? encodeCursor(position(last)) : null,
  };
}
