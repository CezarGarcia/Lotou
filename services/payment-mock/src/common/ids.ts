import { v7 as uuidv7 } from 'uuid';

/** Todo ID do Lotou é um UUID v7: ordenável por tempo e sem revelar volume. */
export const newId = (): string => uuidv7();
