import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  IDEMPOTENCY_TTL_MS,
  IdempotencyRecord,
} from './idempotency-record.schema.js';

/**
 * Depois deste prazo, uma requisição IN_PROGRESS é considerada abandonada (o
 * processo caiu no meio) e uma repetição pode assumir.
 */
export const LOCK_TIMEOUT_MS = 30_000;

const DUPLICATE_KEY = 11_000;

export interface StoredResponse {
  body: unknown;
  location?: string;
}

export type BeginOutcome =
  | { kind: 'started' }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'in-progress' }
  | { kind: 'mismatch' };

@Injectable()
export class IdempotencyStore {
  constructor(
    @InjectModel(IdempotencyRecord.name)
    private readonly records: Model<IdempotencyRecord>,
  ) {}

  /** Tenta reservar a chave. Só uma requisição recebe `started`. */
  async begin(id: string, requestHash: string): Promise<BeginOutcome> {
    const now = new Date();
    try {
      await this.records.create({
        _id: id,
        requestHash,
        status: 'IN_PROGRESS',
        lockedAt: now,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
      });
      return { kind: 'started' };
    } catch (error) {
      if ((error as { code?: number }).code !== DUPLICATE_KEY) {
        throw error;
      }
    }

    const existing = await this.records.findById(id).lean();
    if (!existing) {
      // Expirou entre o insert e a leitura: trata como requisição nova.
      return this.begin(id, requestHash);
    }
    if (existing.requestHash !== requestHash) {
      return { kind: 'mismatch' };
    }
    if (existing.status === 'COMPLETED') {
      return {
        kind: 'replay',
        response: {
          body: JSON.parse(existing.responseBody ?? 'null') as unknown,
          location: existing.responseLocation,
        },
      };
    }

    // IN_PROGRESS: assume só se a tentativa anterior foi abandonada. O filtro
    // por `lockedAt` garante que duas repetições não assumam ao mesmo tempo.
    const abandonedBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);
    if (existing.lockedAt < abandonedBefore) {
      const takenOver = await this.records.findOneAndUpdate(
        { _id: id, status: 'IN_PROGRESS', lockedAt: existing.lockedAt },
        { $set: { lockedAt: now } },
      );
      if (takenOver) {
        return { kind: 'started' };
      }
    }
    return { kind: 'in-progress' };
  }

  async complete(id: string, response: StoredResponse): Promise<void> {
    await this.records.updateOne(
      { _id: id },
      {
        $set: {
          status: 'COMPLETED',
          responseBody: JSON.stringify(response.body ?? null),
          responseLocation: response.location,
        },
      },
    );
  }

  /** A requisição falhou: libera a chave para o cliente tentar de novo. */
  async release(id: string): Promise<void> {
    await this.records.deleteOne({ _id: id, status: 'IN_PROGRESS' });
  }
}
