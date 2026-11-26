import { contractExample } from '../../test/support/contracts.js';
import { handleInventoryEvent } from './inventory-event.handler.js';

const noWait = { attempts: 3, backoffMs: 0 };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('handleInventoryEvent', () => {
  it.each(['LotSoldOut', 'LotOpened'])(
    'lê o exemplo de %s do contrato e apaga o cache do show',
    async (type) => {
      const example = contractExample('inventory.events', type);
      const invalidate = vi.fn().mockResolvedValue(undefined);

      const outcome = await handleInventoryEvent(
        bytes(example),
        invalidate,
        noWait,
      );

      const showId = (example.payload as { showId: string }).showId;
      expect(outcome).toEqual({
        result: 'processed',
        type,
        eventId: example.eventId,
        showId,
      });
      expect(invalidate).toHaveBeenCalledExactlyOnceWith(showId);
    },
  );

  it.each(['ReservationConfirmed', 'ReservationReleased'])(
    'ignora %s: não muda a página do show',
    async (type) => {
      const invalidate = vi.fn();
      const outcome = await handleInventoryEvent(
        bytes(contractExample('inventory.events', type)),
        invalidate,
        noWait,
      );
      expect(outcome).toMatchObject({ result: 'ignored', type });
      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it('ignora um tipo que ainda não conhece', async () => {
    const outcome = await handleInventoryEvent(
      bytes({ eventId: 'x', type: 'LotRepriced', version: 1, payload: {} }),
      vi.fn(),
      noWait,
    );
    expect(outcome).toMatchObject({ result: 'ignored', type: 'LotRepriced' });
  });

  it('ignora uma versão nova de um tipo conhecido (o produtor publica as duas)', async () => {
    const example = contractExample('inventory.events', 'LotSoldOut');
    const invalidate = vi.fn();
    const outcome = await handleInventoryEvent(
      bytes({ ...example, version: 2 }),
      invalidate,
      noWait,
    );
    expect(outcome.result).toBe('ignored');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a mesma mensagem duas vezes só apaga a chave de novo', async () => {
    const example = bytes(contractExample('inventory.events', 'LotSoldOut'));
    const invalidate = vi.fn().mockResolvedValue(undefined);

    await handleInventoryEvent(example, invalidate, noWait);
    const again = await handleInventoryEvent(example, invalidate, noWait);

    expect(again.result).toBe('processed');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['não é JSON', Buffer.from('{oops')],
    ['vazia', null],
    ['sem envelope', bytes({ showId: 'x' })],
  ])('mensagem %s vai para a DLT sem tentar de novo', async (_, value) => {
    const invalidate = vi.fn();
    const outcome = await handleInventoryEvent(value, invalidate, noWait);
    expect(outcome.result).toBe('dead_lettered');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('tipo conhecido com payload inválido vai para a DLT', async () => {
    const example = contractExample('inventory.events', 'LotOpened');
    const outcome = await handleInventoryEvent(
      bytes({ ...example, payload: { showId: 'não é uuid' } }),
      vi.fn(),
      noWait,
    );
    expect(outcome).toMatchObject({
      result: 'dead_lettered',
      type: 'LotOpened',
      eventId: example.eventId,
    });
  });

  it('tenta de novo quando o Redis falha e segue quando ele volta', async () => {
    const invalidate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Redis fora'))
      .mockResolvedValueOnce(undefined);

    const outcome = await handleInventoryEvent(
      bytes(contractExample('inventory.events', 'LotSoldOut')),
      invalidate,
      noWait,
    );

    expect(outcome.result).toBe('processed');
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it('depois das tentativas, vai para a DLT com o motivo', async () => {
    const invalidate = vi.fn().mockRejectedValue(new Error('Redis fora'));

    const outcome = await handleInventoryEvent(
      bytes(contractExample('inventory.events', 'LotSoldOut')),
      invalidate,
      noWait,
    );

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({
      result: 'dead_lettered',
      type: 'LotSoldOut',
    });
    expect(outcome.result === 'dead_lettered' && outcome.reason).toMatch(
      /3 vezes.*Redis fora/,
    );
  });
});
