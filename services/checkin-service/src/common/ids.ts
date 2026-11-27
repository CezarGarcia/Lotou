import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

/** Todo ID do Lotou é um UUID v7: ordenável por tempo e sem revelar volume. */
export const newId = (): string => uuidv7();

/**
 * ID recebido do cliente: um UUID, sempre em minúsculas, como o Postgres e os
 * contratos o escrevem (comparar com o ID do ingresso não depende da caixa).
 */
export const idSchema = z
  .uuid('ID inválido')
  .transform((value) => value.toLowerCase());
