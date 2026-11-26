import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';

/** Todo ID do Lotou é um UUID v7: ordenável por tempo e sem revelar volume. */
export const newId = (): string => uuidv7();

export const idSchema = z.uuidv7('ID inválido');
