import { CheckinResponse } from '../data/checkin.api';
import {
  acceptedOnRetry,
  connectionFailure,
  describeCheckin,
  placeOf,
  scanSentence,
} from './scan-result';

const ticket = { ticketId: 't1', sectorName: 'Plateia', seat: 'A-5' };
const response = (value: Partial<CheckinResponse>): CheckinResponse => ({
  result: 'ACCEPTED',
  ticket: null,
  firstEntry: null,
  ...value,
});

/** 16/12/2026 às 21:00 em Recife (UTC-3). */
const NOW = Date.parse('2026-12-17T00:00:00Z');
const options = { timezone: 'America/Recife', now: NOW };

describe('describeCheckin', () => {
  it('libera em verde, com setor e cadeira', () => {
    const view = describeCheckin(response({ ticket }), options);
    expect(view).toMatchObject({
      tone: 'ok',
      title: 'Entrada liberada',
      place: 'Plateia · Cadeira A-5',
    });
  });

  it('pista não tem cadeira', () => {
    expect(placeOf({ ticketId: 't', sectorName: 'Pista', seat: null })).toBe('Pista');
    expect(placeOf(null)).toBe('');
  });

  it('já utilizado em amarelo, com a hora da primeira entrada no fuso do show e o portão', () => {
    const view = describeCheckin(
      response({
        result: 'ALREADY_USED',
        ticket,
        firstEntry: { at: '2026-12-16T23:31:00Z', gate: 'Portão B' },
      }),
      options,
    );
    expect(view.tone).toBe('warn');
    expect(view.title).toBe('Ingresso já utilizado');
    expect(view.detail).toBe('Entrou às 20:31 pelo Portão B.');
  });

  it('entrada de outro dia mostra a data', () => {
    const view = describeCheckin(
      response({
        result: 'ALREADY_USED',
        firstEntry: { at: '2026-12-15T23:31:00Z', gate: 'Portão A' },
      }),
      options,
    );
    expect(view.detail).toBe('Entrou em 15/12 às 20:31 pelo Portão A.');
  });

  it.each([
    ['INVALID_CODE', 'QR code inválido', 'não é um ingresso do Lotou'],
    ['UNKNOWN_TICKET', 'Ingresso não encontrado', 'atendimento'],
    ['CANCELLED', 'Ingresso cancelado', 'cancelado ou reembolsado'],
    ['WRONG_SHOW', 'Ingresso de outro show', 'Confira o show'],
    ['NOT_OPEN', 'Portões ainda fechados', 'ainda não foi aberta'],
    ['RESULTADO_NOVO', 'Entrada não liberada', 'não reconheceu'],
  ])('barra em vermelho: %s', (result, title, detail) => {
    const view = describeCheckin(response({ result }), options);
    expect(view.tone).toBe('error');
    expect(view.title).toBe(title);
    expect(view.detail).toContain(detail);
  });

  it('portões fechados dizem quando abrem', () => {
    const view = describeCheckin(response({ result: 'NOT_OPEN' }), {
      ...options,
      doorsOpenAt: '2026-12-16T21:00:00Z',
    });
    expect(view.detail).toBe('A entrada abre às 18:00.');
  });
});

describe('textos auxiliares', () => {
  it('falha de conexão pede para ler de novo', () => {
    expect(connectionFailure('Sem conexão com o servidor.')).toMatchObject({
      tone: 'error',
      title: 'Não foi possível validar',
      detail: 'Sem conexão com o servidor. Leia o ingresso de novo.',
    });
  });

  it('a entrada confirmada na segunda tentativa fica verde', () => {
    expect(acceptedOnRetry(response({ result: 'ALREADY_USED', ticket }))).toMatchObject({
      tone: 'ok',
      place: 'Plateia · Cadeira A-5',
    });
  });

  it('frase para leitores de tela', () => {
    const view = describeCheckin(
      response({
        result: 'ALREADY_USED',
        ticket,
        firstEntry: { at: '2026-12-16T23:31:00Z', gate: 'Portão B' },
      }),
      options,
    );
    expect(scanSentence(view)).toBe(
      'Ingresso já utilizado. Plateia · Cadeira A-5. Entrou às 20:31 pelo Portão B.',
    );
  });
});
