import { setTimeout as sleep } from 'node:timers/promises';
import { DECLINE_REASONS, type DeclineReason } from '../messages/events.js';

/** Fonte de números em [0, 1). Os testes trocam por uma sequência fixa. */
export type RandomSource = () => number;
export const RANDOM_SOURCE = Symbol('RANDOM_SOURCE');

export type Sleep = (ms: number) => Promise<unknown>;

export interface GatewayOptions {
  /** Fração das autorizações recusadas, de 0 a 1. */
  declineRate: number;
  /** Fração dos estornos que falham, de 0 a 1. */
  refundFailureRate: number;
  latencyMinMs: number;
  latencyMaxMs: number;
}

export type AuthorizationDecision =
  { approved: true } | { approved: false; reason: DeclineReason };

export interface RefundDecision {
  succeeded: boolean;
}

/**
 * O "banco" do outro lado: decide se aprova, recusa ou estorna, e demora como
 * um gateway de verdade. Não guarda nada; quem guarda a decisão é o
 * PaymentsService, para responder igual a um comando repetido.
 *
 * Com a latência mínima igual à máxima, não sorteia a latência; assim a
 * sequência de números dos testes só decide o resultado.
 */
export class SimulatedGateway {
  constructor(
    private readonly options: GatewayOptions,
    private readonly random: RandomSource = Math.random,
    private readonly wait: Sleep = sleep,
  ) {}

  async authorize(): Promise<AuthorizationDecision> {
    await this.latency();
    if (this.random() < this.options.declineRate) {
      return { approved: false, reason: this.pick(DECLINE_REASONS) };
    }
    return { approved: true };
  }

  async refund(): Promise<RefundDecision> {
    await this.latency();
    return { succeeded: !(this.random() < this.options.refundFailureRate) };
  }

  private async latency(): Promise<void> {
    const { latencyMinMs: min, latencyMaxMs: max } = this.options;
    const ms =
      max > min ? min + Math.floor(this.random() * (max - min + 1)) : min;
    if (ms > 0) {
      await this.wait(ms);
    }
  }

  private pick<T>(options: readonly T[]): T {
    const index = Math.floor(this.random() * options.length);
    return options[Math.min(index, options.length - 1)];
  }
}
