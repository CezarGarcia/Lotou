import { HttpErrorResponse } from '@angular/common/http';
import { toApiError } from './problem';

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
});
