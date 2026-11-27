import { CheckinResponse } from '../data/checkin.api';
import {
  SCAN_ICONS,
  acceptedOnRetry,
  clockOf,
  connectionFailure,
  describeCheckin,
  describeSyncNotice,
  placeOf,
  scanSentence,
  ticketEnd,
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
      icon: 'lucideCircleCheck',
    });
  });

  it('mostra o final do ingresso, quando ele é conhecido', () => {
    const known = {
      ticketId: '0192a1b2-c3d4-7e5f-8a9b-ab81914b0001',
      sectorName: 'Pista',
      seat: null,
    };
    expect(ticketEnd(known)).toBe('…914b0001');
    expect(describeCheckin(response({ ticket: known }), options).ticket).toBe('…914b0001');
    expect(ticketEnd(null)).toBe('');
  });

  it('todo ícone de resultado está registrado para o leitor', () => {
    const results = [
      'ACCEPTED',
      'ALREADY_USED',
      'INVALID_CODE',
      'UNKNOWN_TICKET',
      'CANCELLED',
      'WRONG_SHOW',
      'NOT_OPEN',
      'WRONG_SECTOR',
      'OUTRO',
    ];
    const icons = [
      ...results.map((result) => describeCheckin(response({ result }), options).icon),
      connectionFailure('x').icon,
      'lucideLock',
    ];
    for (const icon of icons) {
      expect(Object.keys(SCAN_ICONS)).toContain(icon);
    }
  });

  it('a hora da leitura sai com segundos, no fuso do show', () => {
    expect(clockOf('2026-12-17T00:00:05Z', 'America/Recife')).toBe('21:00:05');
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

  it('setor de outro portão fica amarelo, com o setor do ingresso', () => {
    const view = describeCheckin(
      response({ result: 'WRONG_SECTOR', ticket: { ...ticket, seat: null } }),
      options,
    );
    expect(view).toMatchObject({
      tone: 'warn',
      title: 'Setor de outro portão',
      detail: 'Ingresso do setor Plateia, que este portão não atende.',
      place: 'Plateia',
    });
    expect(view.advice).toContain('portão do setor');
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

describe('avisos do envio das leituras sem internet', () => {
  const scan = {
    id: 'l1',
    code: 'LOTOU2.x',
    scannedAt: '2026-12-16T23:41:07Z',
    showId: 's1',
    gate: 'Portão A',
    deviceId: 'd1',
    ticketId: '0192a1b2-c3d4-7e5f-8a9b-ab81914b0001',
  };
  const pista = {
    id: scan.ticketId,
    sectorId: 'p',
    sectorName: 'Pista',
    seat: null,
    status: 'VALID' as const,
  };

  it('entrada dupla: amarela, com a entrada que valeu no fuso do show', () => {
    const view = describeSyncNotice(
      {
        scan,
        ticket: pista,
        result: {
          id: 'l1',
          outcome: 'DUPLICATE',
          firstEntry: { gate: 'Portão B', checkedInAt: '2026-12-16T23:40:00Z' },
        },
      },
      options,
    );
    expect(view).toMatchObject({
      tone: 'warn',
      title: 'Entrada dupla detectada',
      detail: 'Já tinha entrado às 20:40 pelo Portão B.',
      place: 'Pista',
      ticket: '…914b0001',
    });
  });

  it.each([
    ['CANCELLED', 'Entrou com ingresso cancelado'],
    ['WRONG_SHOW', 'Entrou com ingresso de outro show'],
    ['UNKNOWN', 'Entrou com ingresso fora da lista'],
  ])('conflito %s fica registrado, sem barrar ninguém', (kind, title) => {
    const view = describeSyncNotice(
      { scan, ticket: undefined, result: { id: 'l1', outcome: 'CONFLICT', kind } },
      options,
    );
    expect(view).toMatchObject({ tone: 'warn', title, place: '' });
    expect(view.detail).toContain('ficou registrado');
  });

  it('leitura recusada no envio', () => {
    const view = describeSyncNotice(
      {
        scan,
        ticket: undefined,
        result: { id: 'l1', outcome: 'REJECTED', reason: 'INVALID_TIME' },
      },
      options,
    );
    expect(view).toMatchObject({ tone: 'error', title: 'Leitura sem internet recusada' });
    expect(view.detail).toContain('relógio');
  });

  it('a frase para leitores de tela diz que a decisão foi do aparelho', () => {
    const view = { ...describeCheckin(response({ ticket }), options), offline: true };
    expect(scanSentence(view)).toBe(
      'Entrada liberada. Plateia · Cadeira A-5. Validado neste aparelho, sem internet',
    );
  });
});
