import { newId } from '../common/ids/id.js';

/**
 * Envelope de toda mensagem do Kafka (contracts/README.md): `eventId` em UUID
 * v7, `type` no passado para eventos, `version` do payload daquele tipo e
 * `occurredAt` em UTC.
 */
export interface Envelope<T> {
  eventId: string;
  type: string;
  version: number;
  occurredAt: string;
  payload: T;
}

export function envelope<T>(
  type: string,
  version: number,
  occurredAt: Date,
  payload: T,
): Envelope<T> {
  return {
    eventId: newId(),
    type,
    version,
    occurredAt: occurredAt.toISOString(),
    payload,
  };
}
