import {
  type GatewayOptions,
  type RandomSource,
  SimulatedGateway,
} from './simulated-gateway.js';

/** Devolve os números na ordem dada; acabou a lista, o teste está errado. */
function sequence(...values: number[]): RandomSource {
  return () => {
    const next = values.shift();
    if (next === undefined) {
      throw new Error('Sequência de números esgotada');
    }
    return next;
  };
}

const noLatency: GatewayOptions = {
  declineRate: 0,
  refundFailureRate: 0,
  latencyMinMs: 0,
  latencyMaxMs: 0,
};
const noWait = () => Promise.resolve();

describe('SimulatedGateway', () => {
  describe('authorize', () => {
    it('aprova tudo com DECLINE_RATE=0', async () => {
      const gateway = new SimulatedGateway(noLatency, sequence(0), noWait);
      await expect(gateway.authorize()).resolves.toEqual({ approved: true });
    });

    it('recusa tudo com DECLINE_RATE=1', async () => {
      const gateway = new SimulatedGateway(
        { ...noLatency, declineRate: 1 },
        sequence(0.999, 0.5),
        noWait,
      );
      await expect(gateway.authorize()).resolves.toEqual({
        approved: false,
        reason: 'CARD_DECLINED',
      });
    });

    it('com 30%, recusa quando o sorteio fica abaixo de 0,3', async () => {
      const options = { ...noLatency, declineRate: 0.3 };
      const declined = new SimulatedGateway(options, sequence(0.29, 0), noWait);
      const approved = new SimulatedGateway(options, sequence(0.3), noWait);
      await expect(declined.authorize()).resolves.toEqual({
        approved: false,
        reason: 'INSUFFICIENT_FUNDS',
      });
      await expect(approved.authorize()).resolves.toEqual({ approved: true });
    });

    it.each([
      [0, 'INSUFFICIENT_FUNDS'],
      [0.34, 'CARD_DECLINED'],
      [0.9999, 'FRAUD_SUSPECTED'],
    ])('sorteia o motivo da recusa (%d dá %s)', async (draw, reason) => {
      const gateway = new SimulatedGateway(
        { ...noLatency, declineRate: 1 },
        sequence(0, draw),
        noWait,
      );
      await expect(gateway.authorize()).resolves.toMatchObject({ reason });
    });

    it('chega perto do DECLINE_RATE numa amostra grande', async () => {
      let seed = 42;
      // Gerador simples e determinístico (LCG), para o teste não oscilar.
      const lcg: RandomSource = () => {
        seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
        return seed / 2 ** 32;
      };
      const gateway = new SimulatedGateway(
        { ...noLatency, declineRate: 0.3 },
        lcg,
        noWait,
      );
      let declined = 0;
      for (let i = 0; i < 10_000; i++) {
        if (!(await gateway.authorize()).approved) {
          declined++;
        }
      }
      expect(declined / 10_000).toBeCloseTo(0.3, 1);
    });
  });

  describe('refund', () => {
    it('estorna tudo com REFUND_FAILURE_RATE=0', async () => {
      const gateway = new SimulatedGateway(noLatency, sequence(0), noWait);
      await expect(gateway.refund()).resolves.toEqual({ succeeded: true });
    });

    it('falha tudo com REFUND_FAILURE_RATE=1', async () => {
      const gateway = new SimulatedGateway(
        { ...noLatency, refundFailureRate: 1 },
        sequence(0.999),
        noWait,
      );
      await expect(gateway.refund()).resolves.toEqual({ succeeded: false });
    });
  });

  describe('latência', () => {
    it('sorteia entre o mínimo e o máximo, inclusive', async () => {
      const waits: number[] = [];
      const wait = (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      };
      const options = { ...noLatency, latencyMinMs: 50, latencyMaxMs: 150 };
      await new SimulatedGateway(options, sequence(0, 0), wait).authorize();
      await new SimulatedGateway(
        options,
        sequence(0.9999, 0),
        wait,
      ).authorize();
      await new SimulatedGateway(options, sequence(0.5, 0), wait).refund();
      expect(waits).toEqual([50, 150, 100]);
    });

    it('com mínimo igual ao máximo, espera esse tempo sem sortear', async () => {
      const wait = vi.fn(() => Promise.resolve());
      const gateway = new SimulatedGateway(
        { ...noLatency, latencyMinMs: 30, latencyMaxMs: 30 },
        sequence(0),
        wait,
      );
      await gateway.authorize();
      expect(wait).toHaveBeenCalledWith(30);
    });

    it('sem latência, não espera', async () => {
      const wait = vi.fn(() => Promise.resolve());
      await new SimulatedGateway(noLatency, sequence(0), wait).authorize();
      expect(wait).not.toHaveBeenCalled();
    });
  });
});
