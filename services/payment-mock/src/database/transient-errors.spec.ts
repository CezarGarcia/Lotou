import { NonRetryableError } from '../common/errors.js';
import { isTransientError } from './transient-errors.js';

const withCode = (code: string, message = 'erro') =>
  Object.assign(new Error(message), { code });

describe('isTransientError', () => {
  it.each([
    ['conexão recusada', withCode('ECONNREFUSED')],
    ['conexão derrubada', withCode('ECONNRESET')],
    ['Postgres desligando', withCode('57P01')],
    ['Postgres subindo', withCode('57P03')],
    ['falha de conexão (classe 08)', withCode('08006')],
    ['conexões esgotadas', withCode('53300')],
    ['deadlock', withCode('40P01')],
    ['timeout do pool', new Error('timeout exceeded when trying to connect')],
    ['conexão encerrada', new Error('Connection terminated unexpectedly')],
    [
      'todos os endereços recusados',
      new AggregateError([withCode('ECONNREFUSED'), withCode('ECONNREFUSED')]),
    ],
  ])('trata %s como passageiro', (_, error) => {
    expect(isTransientError(error)).toBe(true);
  });

  it.each([
    ['violação de constraint', withCode('23514')],
    ['erro de sintaxe', withCode('42601')],
    ['erro de programação', new TypeError('x is undefined')],
    ['erro sem retry', new NonRetryableError('transição inválida')],
    ['algo que não é erro', 'ECONNREFUSED'],
  ])('não trata %s como passageiro', (_, error) => {
    expect(isTransientError(error)).toBe(false);
  });
});
