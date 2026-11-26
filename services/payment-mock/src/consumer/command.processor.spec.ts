import { contractExample } from '../../test/support/contracts.js';
import { NonRetryableError } from '../common/errors.js';
import type { PaymentCommand } from '../messages/commands.js';
import { CommandProcessor, type CommandHandler } from './command.processor.js';
import type { IncomingMessage } from './incoming-message.js';
import type { RetryPolicy } from './retry-policy.js';

const policy: RetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 1,
  maxBackoffMs: 4,
  transientBudgetMs: 50,
};

const authorize = contractExample('payment.commands', 'AuthorizePayment');
const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

function message(value: unknown, offset = '7'): IncomingMessage {
  return {
    topic: 'payment.commands',
    partition: 1,
    offset,
    key: Buffer.from(authorize.payload.orderId),
    value:
      value === null
        ? null
        : Buffer.from(
            typeof value === 'string' ? value : JSON.stringify(value),
          ),
    headers: { traceparent: Buffer.from(TRACEPARENT) },
  };
}

function setup(handle: CommandHandler['handle'] = async () => undefined) {
  const handler = { handle: vi.fn(handle) };
  const deadLetters = { publish: vi.fn(async () => undefined) };
  const processor = new CommandProcessor(handler, deadLetters, policy);
  return { handler, deadLetters, processor };
}

/** Erro como o do driver `pg` com o Postgres fora. */
const connectionRefused = () =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
    code: 'ECONNREFUSED',
  });

describe('CommandProcessor', () => {
  it('entrega o comando lido ao handler, com o traceparent recebido', async () => {
    const { handler, deadLetters, processor } = setup();

    await processor.process(message(authorize));

    expect(handler.handle).toHaveBeenCalledTimes(1);
    const [command, trace] = handler.handle.mock.calls[0] as [
      PaymentCommand,
      unknown,
    ];
    expect(command).toMatchObject({
      type: 'AuthorizePayment',
      eventId: authorize.eventId,
      payload: authorize.payload,
    });
    expect(trace).toEqual({ traceparent: TRACEPARENT });
    expect(deadLetters.publish).not.toHaveBeenCalled();
  });

  it('ignora tipo desconhecido, sem DLT', async () => {
    const { handler, deadLetters, processor } = setup();

    await processor.process(message({ ...authorize, type: 'CapturePayment' }));

    expect(handler.handle).not.toHaveBeenCalled();
    expect(deadLetters.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON quebrado', '{"eventId": '],
    ['valor vazio', null],
    ['payload fora do contrato', { ...authorize, payload: { orderId: 'x' } }],
  ])('manda %s direto para a DLT, sem tentar de novo', async (_, value) => {
    const { handler, deadLetters, processor } = setup();
    const incoming = message(value);

    await processor.process(incoming);

    expect(handler.handle).not.toHaveBeenCalled();
    expect(deadLetters.publish).toHaveBeenCalledTimes(1);
    expect(deadLetters.publish).toHaveBeenCalledWith(
      incoming,
      expect.objectContaining({ name: 'PoisonMessageError' }),
      1,
    );
  });

  it('tenta de novo um erro comum e segue quando passa', async () => {
    let calls = 0;
    const { handler, deadLetters, processor } = setup(async () => {
      if (++calls < 3) {
        throw new Error('falhou');
      }
    });

    await processor.process(message(authorize));

    expect(handler.handle).toHaveBeenCalledTimes(3);
    expect(deadLetters.publish).not.toHaveBeenCalled();
  });

  it('depois de maxAttempts, manda para a DLT e segue para a próxima', async () => {
    const { handler, deadLetters, processor } = setup(async () => {
      throw new Error('sempre falha');
    });

    await expect(
      processor.process(message(authorize)),
    ).resolves.toBeUndefined();

    expect(handler.handle).toHaveBeenCalledTimes(3);
    expect(deadLetters.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'sempre falha' }),
      3,
    );
  });

  it('erro que não passa com nova tentativa vai à DLT na primeira', async () => {
    const { handler, deadLetters, processor } = setup(async () => {
      throw new NonRetryableError('transição inválida');
    });

    await processor.process(message(authorize));

    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(deadLetters.publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(NonRetryableError),
      1,
    );
  });

  it('falha passageira nunca vai à DLT: insiste e passa quando a infraestrutura volta', async () => {
    let calls = 0;
    const { handler, deadLetters, processor } = setup(async () => {
      if (++calls <= policy.maxAttempts + 2) {
        throw connectionRefused();
      }
    });

    await processor.process(message(authorize));

    expect(handler.handle).toHaveBeenCalledTimes(policy.maxAttempts + 3);
    expect(deadLetters.publish).not.toHaveBeenCalled();
  });

  it('falha passageira que passa do orçamento devolve a mensagem ao Kafka, sem confirmar', async () => {
    const { deadLetters, processor } = setup(async () => {
      throw connectionRefused();
    });

    await expect(processor.process(message(authorize))).rejects.toThrow(
      /ECONNREFUSED/,
    );
    expect(deadLetters.publish).not.toHaveBeenCalled();
  });

  it('se a DLT falha, a mensagem não é confirmada', async () => {
    const { deadLetters, processor } = setup();
    deadLetters.publish.mockRejectedValueOnce(new Error('broker fora'));

    await expect(processor.process(message('não é json'))).rejects.toThrow(
      'broker fora',
    );
  });

  it('ao parar, abandona as tentativas sem DLT', async () => {
    const slow: RetryPolicy = {
      ...policy,
      initialBackoffMs: 10_000,
      maxBackoffMs: 10_000,
    };
    const handler = {
      handle: vi.fn(async () => {
        throw new Error('falhou');
      }),
    };
    const deadLetters = { publish: vi.fn(async () => undefined) };
    const processor = new CommandProcessor(handler, deadLetters, slow);

    const processing = processor.process(message(authorize));
    await vi.waitFor(() => expect(handler.handle).toHaveBeenCalled());
    processor.stop();

    await expect(processing).rejects.toThrow();
    expect(deadLetters.publish).not.toHaveBeenCalled();
  });
});
