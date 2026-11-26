import { TOPICS } from '../src/kafka/topics.js';
import { createTestApp, paymentsOf, type TestApp } from './support/app.js';
import { contractErrors } from './support/contracts.js';
import { authorizeCommand, refundCommand } from './support/fixtures.js';
import {
  CommandSender,
  type Received,
  TopicRecorder,
} from './support/kafka.js';

describe('RefundPayment', () => {
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
  afterEach(() => {
    vi.restoreAllMocks();
    t.draws.approve();
  });
  afterAll(async () => {
    await Promise.all([t?.close(), sender?.stop(), recorder?.stop()]);
  });

  /** Envia o comando e devolve a resposta seguinte do pedido. */
  async function answer(
    command: ReturnType<typeof authorizeCommand | typeof refundCommand>,
  ): Promise<Received> {
    const orderId = command.payload.orderId;
    const before = recorder.answers(orderId).length;
    await sender.send(command);
    const answers = await recorder.waitForAnswers(orderId, before + 1);
    const last = answers[before];
    expect(contractErrors(TOPICS.events, last.value)).toEqual([]);
    return last;
  }

  async function authorized(): Promise<{ orderId: string; paymentId: string }> {
    const command = authorizeCommand();
    const reply = await answer(command);
    expect(reply.value.type).toBe('PaymentAuthorized');
    return {
      orderId: command.payload.orderId,
      paymentId: reply.value.payload.paymentId,
    };
  }

  it('estorna o pagamento aprovado e repete a mesma resposta a um estorno repetido', async () => {
    const metrics = vi.spyOn(t.metrics, 'record');
    const { orderId, paymentId } = await authorized();

    const refunded = await answer(refundCommand(orderId));
    expect(refunded.value).toMatchObject({
      type: 'PaymentRefunded',
      payload: { orderId, paymentId, amountCents: 32_000 },
    });
    const [payment] = await paymentsOf(t.pool, orderId);
    expect(payment).toMatchObject({
      status: 'REFUNDED',
      refunded_amount_cents: '32000',
      refund_attempts: 1,
    });

    // Um novo pedido de estorno não estorna de novo, mesmo que agora falhasse.
    t.draws.decline();
    const again = await answer(refundCommand(orderId));
    expect(again.value.type).toBe('PaymentRefunded');
    expect(again.value.payload).toEqual(refunded.value.payload);
    expect((await paymentsOf(t.pool, orderId))[0].refund_attempts).toBe(1);
    expect(metrics.mock.calls).toEqual([['authorized'], ['refunded']]);
  });

  it('estorno que falha responde RefundFailed com a tentativa, e o seguinte pode concluir', async () => {
    const { orderId, paymentId } = await authorized();

    t.draws.decline();
    const first = await answer(refundCommand(orderId));
    const second = await answer(refundCommand(orderId));
    t.draws.approve();
    const third = await answer(refundCommand(orderId));

    expect(first.value).toMatchObject({
      type: 'RefundFailed',
      payload: { paymentId, attempt: 1, amountCents: 32_000 },
    });
    expect(second.value).toMatchObject({
      type: 'RefundFailed',
      payload: { attempt: 2 },
    });
    expect(third.value).toMatchObject({ type: 'PaymentRefunded' });
    expect((await paymentsOf(t.pool, orderId))[0]).toMatchObject({
      status: 'REFUNDED',
      refund_attempts: 3,
    });
  });

  it('estorno de pagamento recusado responde PaymentRefunded de valor 0', async () => {
    t.draws.decline();
    const command = authorizeCommand();
    const { orderId } = command.payload;
    const declined = await answer(command);
    expect(declined.value.type).toBe('PaymentDeclined');

    const refunded = await answer(refundCommand(orderId));

    expect(refunded.value).toMatchObject({
      type: 'PaymentRefunded',
      payload: { paymentId: declined.value.payload.paymentId, amountCents: 0 },
    });
    expect((await paymentsOf(t.pool, orderId))[0].status).toBe('DECLINED');
  });

  it('estorno de pedido sem pagamento anula o pedido; a autorização atrasada é recusada', async () => {
    const metrics = vi.spyOn(t.metrics, 'record');
    const { orderId } = authorizeCommand().payload;

    const refunded = await answer(refundCommand(orderId));
    expect(refunded.value).toMatchObject({
      type: 'PaymentRefunded',
      payload: { orderId, amountCents: 0 },
    });
    expect((await paymentsOf(t.pool, orderId))[0]).toMatchObject({
      status: 'VOIDED',
      buyer_id: null,
    });

    // O gateway aprovaria, mas o pedido já foi cancelado.
    const late = await answer(authorizeCommand(orderId));
    expect(late.value).toMatchObject({
      type: 'PaymentDeclined',
      payload: {
        paymentId: refunded.value.payload.paymentId,
        reason: 'CARD_DECLINED',
      },
    });
    expect(await paymentsOf(t.pool, orderId)).toHaveLength(1);
    expect(metrics).not.toHaveBeenCalled();
  });

  it('as respostas de um pedido saem na ordem dos comandos', async () => {
    const { orderId } = authorizeCommand().payload;
    t.draws.decline();
    // Sem esperar as respostas: os comandos vão em sequência na mesma partição.
    await sender.send(authorizeCommand(orderId));
    await sender.send(refundCommand(orderId));
    await sender.send(authorizeCommand(orderId));

    const answers = await recorder.waitForAnswers(orderId, 3);

    expect(answers.map((a) => a.value.type)).toEqual([
      'PaymentDeclined',
      'PaymentRefunded',
      'PaymentDeclined',
    ]);
    expect(new Set(answers.map((a) => a.partition)).size).toBe(1);
  });
});
