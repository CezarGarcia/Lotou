import { migrate } from '../src/database/migrate.js';
import { parseMessage, type PaymentCommand } from '../src/messages/commands.js';
import { createTestApp, paymentsOf, type TestApp } from './support/app.js';
import { authorizeCommand, refundCommand } from './support/fixtures.js';

/** O comando como o consumidor o entrega ao PaymentsService. */
const asCommand = (envelope: object): PaymentCommand => {
  const parsed = parseMessage(Buffer.from(JSON.stringify(envelope)));
  if (parsed.kind !== 'command') {
    throw new Error('comando inválido no teste');
  }
  return parsed.command;
};

/**
 * Comandos do mesmo pedido chegando ao mesmo tempo, como numa troca de dono
 * da partição (duas instâncias processando a mesma mensagem) ou num reenvio do
 * order-service. A garantia vem do banco, não da ordem do Kafka.
 */
describe('Concorrência no mesmo pedido', () => {
  let t: TestApp;

  beforeAll(async () => {
    // Latência fixa (sem sorteio): abre a janela entre a leitura e a transação.
    t = await createTestApp({ LATENCY_MIN_MS: '30', LATENCY_MAX_MS: '30' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    t.draws.approve();
  });
  afterAll(() => t?.close());

  async function outboxOf(orderId: string) {
    const { rows } = await t.pool.query(
      `SELECT type, payload FROM outbox WHERE message_key = $1 ORDER BY seq`,
      [orderId],
    );
    return rows as { type: string; payload: any }[];
  }

  it('dez AuthorizePayment diferentes ao mesmo tempo cobram uma vez só e respondem igual', async () => {
    const metrics = vi.spyOn(t.metrics, 'record');
    const orderId = authorizeCommand().payload.orderId;
    const commands = Array.from({ length: 10 }, () =>
      asCommand(authorizeCommand(orderId)),
    );

    const results = await Promise.all(
      commands.map((command) => t.payments.handle(command)),
    );

    expect(results.every((r) => r.outcome === 'answered')).toBe(true);
    const [payment, ...others] = await paymentsOf(t.pool, orderId);
    expect(others).toEqual([]);
    const answers = await outboxOf(orderId);
    expect(answers).toHaveLength(10);
    expect(new Set(answers.map((a) => a.type))).toEqual(
      new Set(['PaymentAuthorized']),
    );
    expect(new Set(answers.map((a) => a.payload.payload.paymentId))).toEqual(
      new Set([payment.id]),
    );
    expect(metrics.mock.calls).toEqual([['authorized']]);
  });

  it('a mesma mensagem processada cinco vezes ao mesmo tempo tem um efeito só', async () => {
    const command = asCommand(authorizeCommand());

    const results = await Promise.all(
      Array.from({ length: 5 }, () => t.payments.handle(command)),
    );

    expect(results.filter((r) => r.outcome === 'answered')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(4);
    expect(await outboxOf(command.payload.orderId)).toHaveLength(1);
  });

  it('estornos simultâneos do mesmo pagamento estornam uma vez só', async () => {
    const authorize = asCommand(authorizeCommand());
    const { orderId } = authorize.payload;
    await t.payments.handle(authorize);
    const metrics = vi.spyOn(t.metrics, 'record');

    await Promise.all(
      Array.from({ length: 5 }, () =>
        t.payments.handle(asCommand(refundCommand(orderId))),
      ),
    );

    const [payment] = await paymentsOf(t.pool, orderId);
    expect(payment).toMatchObject({ status: 'REFUNDED', refund_attempts: 1 });
    const refunds = (await outboxOf(orderId)).filter(
      (a) => a.type === 'PaymentRefunded',
    );
    expect(refunds).toHaveLength(5);
    expect(new Set(refunds.map((r) => r.payload.payload.refundedAt)).size).toBe(
      1,
    );
    expect(metrics.mock.calls).toEqual([['refunded']]);
  });

  it('as migrações rodam uma vez só, mesmo com instâncias subindo juntas', async () => {
    const applied = await Promise.all([migrate(t.pool), migrate(t.pool)]);

    expect(applied).toEqual([[], []]);
    const { rows } = await t.pool.query(
      'SELECT version FROM schema_migrations',
    );
    expect(rows).toEqual([{ version: '0001_payments.sql' }]);
  });
});
