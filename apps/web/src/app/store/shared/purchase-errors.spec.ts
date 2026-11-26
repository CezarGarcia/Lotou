import { ApiError } from '../../core/http/problem';
import { listPt, purchaseErrorMessage } from './purchase-errors';

const problem = (code: string, details?: Record<string, unknown>, extra: Partial<ApiError> = {}) =>
  purchaseErrorMessage({ status: 409, message: 'detalhe da API', code, details, ...extra });

describe('purchaseErrorMessage', () => {
  it('diz quantos ingressos restam no lote', () => {
    expect(problem('insufficient-stock', { available: 2 })).toBe(
      'Só restam 2 ingressos neste lote. Diminua a quantidade e tente de novo.',
    );
    expect(problem('insufficient-stock', { available: 1 })).toContain('Só resta 1 ingresso');
    expect(problem('insufficient-stock', { available: 0 })).toBe(
      'Os ingressos deste lote acabaram.',
    );
  });

  it('cita as cadeiras que outra pessoa pegou', () => {
    expect(problem('seat-unavailable', { seats: ['A-1'] })).toBe(
      'A cadeira A-1 acabou de ser reservada por outra pessoa. Escolha outra.',
    );
    expect(problem('seat-unavailable', { seats: ['A-1', 'A-2', 'B-4'] })).toContain(
      'As cadeiras A-1, A-2 e B-4 acabaram',
    );
  });

  it('explica o limite de 4 ingressos por CPF', () => {
    expect(problem('purchase-limit-exceeded', { remaining: 1 })).toBe(
      'Este CPF ainda pode comprar 1 ingresso para este show (o limite é 4 por CPF).',
    );
    expect(problem('purchase-limit-exceeded', { remaining: 0 })).toContain('já chegou ao limite');
  });

  it('traduz as situações de venda, a fila e a expiração da reserva', () => {
    expect(problem('sold-out')).toBe('Os ingressos deste setor esgotaram.');
    expect(problem('sales-paused')).toContain('pausadas');
    expect(problem('sales-not-open')).toContain('ainda não abriram');
    expect(problem('sales-closed')).toContain('encerradas');
    expect(problem('queue-admission-required')).toContain('fila virtual');
    expect(problem('inventory-loading')).toContain('alguns segundos');
    expect(problem('reservation-not-held')).toContain('expirou');
    expect(problem('seat-not-found')).toContain('não existe');
  });

  it('usa o Retry-After no limite de taxa', () => {
    expect(problem('rate-limited', undefined, { status: 429, retryAfterSeconds: 3 })).toBe(
      'Muitas tentativas em pouco tempo. Aguarde 3 segundos e tente de novo.',
    );
  });

  it('aponta o CPF recusado pela validação do servidor', () => {
    expect(
      problem('validation-error', { errors: [{ field: 'cpf', message: 'CPF inválido' }] }),
    ).toBe('O CPF informado não é válido. Confira os números.');
  });

  it('cai no detalhe da API para os demais erros', () => {
    expect(purchaseErrorMessage({ status: 500, message: 'Falhou.' })).toBe('Falhou.');
    expect(purchaseErrorMessage({ status: 401, message: 'x' })).toContain('sessão expirou');
  });
});

describe('listPt', () => {
  it('junta itens com vírgula e "e"', () => {
    expect(listPt([])).toBe('');
    expect(listPt(['A-1'])).toBe('A-1');
    expect(listPt(['A-1', 'A-2'])).toBe('A-1 e A-2');
    expect(listPt(['A-1', 'A-2', 'A-3'])).toBe('A-1, A-2 e A-3');
  });
});
