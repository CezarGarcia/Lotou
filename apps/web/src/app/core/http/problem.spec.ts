import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { isTransient, parseRetryAfter, toApiError } from './problem';

describe('toApiError', () => {
  it('usa o detalhe e o traceId do Problem Details', () => {
    const error = new HttpErrorResponse({
      status: 503,
      error: {
        type: 'urn:lotou:problem:upstream-unavailable',
        title: 'Serviço indisponível',
        status: 503,
        detail: 'O serviço não está respondendo.',
        traceId: 'abc123',
      },
    });
    expect(toApiError(error)).toEqual({
      status: 503,
      message: 'O serviço não está respondendo.',
      traceId: 'abc123',
      code: 'upstream-unavailable',
    });
  });

  it('usa o título quando o problema não traz detalhe', () => {
    const error = new HttpErrorResponse({
      status: 404,
      error: { type: 'about:blank', title: 'Not Found', status: 404 },
    });
    expect(toApiError(error).message).toBe('Not Found');
  });

  it('trata falha de rede e resposta fora do formato', () => {
    expect(toApiError(new HttpErrorResponse({ status: 0 })).message).toContain('Sem conexão');
    expect(toApiError(new HttpErrorResponse({ status: 500, error: '<html>' }))).toEqual({
      status: 500,
      message: 'Não foi possível concluir a operação.',
    });
    expect(toApiError(new Error('x')).status).toBe(0);
  });

  it('expõe o tipo do problema e os membros de extensão', () => {
    const error = new HttpErrorResponse({
      status: 409,
      error: {
        type: 'urn:lotou:problem:insufficient-stock',
        title: 'Estoque insuficiente',
        status: 409,
        detail: 'Restam 2 ingressos neste lote.',
        instance: '/v1/reservations',
        available: 2,
      },
    });
    expect(toApiError(error)).toEqual({
      status: 409,
      message: 'Restam 2 ingressos neste lote.',
      code: 'insufficient-stock',
      details: { available: 2 },
    });
  });

  it('lê o Retry-After das respostas 429 e 503', () => {
    const error = new HttpErrorResponse({
      status: 429,
      headers: new HttpHeaders({ 'Retry-After': '7' }),
      error: { type: 'urn:lotou:problem:rate-limited', title: 'Muitas requisições', status: 429 },
    });
    expect(toApiError(error)).toMatchObject({ code: 'rate-limited', retryAfterSeconds: 7 });
  });
});

describe('parseRetryAfter', () => {
  it('aceita segundos ou uma data HTTP', () => {
    const now = Date.UTC(2027, 0, 1, 12, 0, 0);
    expect(parseRetryAfter('3', now)).toBe(3);
    expect(parseRetryAfter('Fri, 01 Jan 2027 12:00:10 GMT', now)).toBe(10);
    expect(parseRetryAfter('amanhã', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('isTransient', () => {
  it('separa falhas passageiras das definitivas', () => {
    expect(isTransient({ status: 0, message: '' })).toBe(true);
    expect(isTransient({ status: 502, message: '' })).toBe(true);
    expect(isTransient({ status: 429, message: '' })).toBe(true);
    expect(isTransient({ status: 503, message: '', code: 'inventory-loading' })).toBe(true);
    expect(isTransient({ status: 409, message: '', code: 'sold-out' })).toBe(false);
    expect(isTransient({ status: 400, message: '' })).toBe(false);
  });
});
