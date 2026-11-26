import { newId } from '../src/common/ids.js';
import { TOPICS } from '../src/kafka/topics.js';
import { createTestApp, paymentsOf, type TestApp } from './support/app.js';
import { authorizeCommand } from './support/fixtures.js';
import { CommandSender, settle, TopicRecorder } from './support/kafka.js';

describe('Consumidor de payment.commands', () => {
  let t: TestApp;
  let sender: CommandSender;
  let recorder: TopicRecorder;

  beforeAll(async () => {
    [t, sender, recorder] = await Promise.all([
      createTestApp(),
      CommandSender.start(),
      TopicRecorder.start(),
    ]);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([t?.close(), sender?.stop(), recorder?.stop()]);
  });

  it('manda JSON quebrado para a DLT, intacto, e segue para o comando seguinte', async () => {
    const orderId = newId();
    const garbage = '{"eventId": "quebrado"';

    // Mesma chave: mesma partição, então o comando válido só é processado
    // depois que o consumidor passa pela mensagem quebrada.
    await sender.send({ raw: garbage, key: orderId }, { traceparent: 'x' });
    await sender.send(authorizeCommand(orderId));

    const [dead] = await recorder.waitFor(TOPICS.commandsDlt, orderId);
    const [answer] = await recorder.waitForAnswers(orderId);

    expect(dead.raw?.toString()).toBe(garbage);
    expect(dead.headers).toMatchObject({
      'dlt.original.topic': TOPICS.commands,
      'dlt.error.class': 'PoisonMessageError',
      'dlt.attempts': '1',
      traceparent: 'x',
    });
    expect(Number(dead.headers['dlt.original.offset'])).toBeGreaterThanOrEqual(
      0,
    );
    expect(dead.headers['dlt.error.message']).toMatch(/JSON/);
    expect(answer.value.type).toBe('PaymentAuthorized');
  });

  it('manda payload fora do contrato para a DLT, sem tentar de novo', async () => {
    const command = authorizeCommand();
    const { orderId } = command.payload;
    const handle = vi.spyOn(t.payments, 'handle');

    await sender.send({
      ...command,
      payload: { ...command.payload, amountCents: -5 },
    });

    const [dead] = await recorder.waitFor(TOPICS.commandsDlt, orderId);
    expect(dead.headers['dlt.error.message']).toMatch(/amountCents/);
    expect(handle).not.toHaveBeenCalled();
    expect(await paymentsOf(t.pool, orderId)).toEqual([]);
  });

  it('ignora tipo desconhecido, sem resposta e sem DLT', async () => {
    const orderId = newId();
    const unknown = { ...authorizeCommand(orderId), type: 'CapturePayment' };

    await sender.send(unknown);
    await sender.send(authorizeCommand(orderId));
    const answers = await recorder.waitForAnswers(orderId);
    await settle(500);

    expect(answers).toHaveLength(1);
    expect(answers[0].value.type).toBe('PaymentAuthorized');
    expect(recorder.of(TOPICS.commandsDlt, orderId)).toEqual([]);
  });

  it('tenta de novo com backoff e, se continua falhando, manda para a DLT e segue', async () => {
    const failing = authorizeCommand();
    const { orderId } = failing.payload;
    const handle = t.payments.handle.bind(t.payments);
    const spy = vi
      .spyOn(t.payments, 'handle')
      .mockImplementation(async (command, trace) => {
        if (command.eventId === failing.eventId) {
          throw new Error('defeito no processamento');
        }
        return handle(command, trace);
      });

    await sender.send(failing);
    await sender.send(authorizeCommand(orderId));

    const [dead] = await recorder.waitFor(TOPICS.commandsDlt, orderId);
    const [answer] = await recorder.waitForAnswers(orderId);
    expect(dead.headers).toMatchObject({
      'dlt.attempts': '3',
      'dlt.error.class': 'Error',
      'dlt.error.message': 'defeito no processamento',
    });
    expect(JSON.parse(dead.raw!.toString())).toEqual(failing);
    const failedCalls = spy.mock.calls.filter(
      ([command]) => command.eventId === failing.eventId,
    );
    expect(failedCalls).toHaveLength(3);
    // O comando seguinte do mesmo pedido foi processado normalmente.
    expect(answer.value.type).toBe('PaymentAuthorized');
  });

  it('com o Postgres falhando por um tempo, insiste sem DLT e responde quando ele volta', async () => {
    const command = authorizeCommand();
    const { orderId } = command.payload;
    const handle = t.payments.handle.bind(t.payments);
    let failures = 0;
    vi.spyOn(t.payments, 'handle').mockImplementation(async (cmd, trace) => {
      if (cmd.eventId === command.eventId && failures < 6) {
        failures++;
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
          code: 'ECONNREFUSED',
        });
      }
      return handle(cmd, trace);
    });

    await sender.send(command);
    const [answer] = await recorder.waitForAnswers(orderId);

    expect(failures).toBe(6);
    expect(answer.value.type).toBe('PaymentAuthorized');
    expect(recorder.of(TOPICS.commandsDlt, orderId)).toEqual([]);
  });
});
