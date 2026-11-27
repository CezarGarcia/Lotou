import { timingSafeEqual } from 'node:crypto';
import { signTicketCode, TicketCodeVerifier } from './ticket-code.js';

const KEY = 'lotou-dev-ticket-qr-key';
const TICKET = '01a21a00-0000-7000-8000-000000000013';
/**
 * Calculado fora do Node (Python, `hmac` + `base64.urlsafe_b64encode`), como o
 * `TicketCodes` do order-service calcula: HMAC-SHA256 de `LOTOU1.<id>`.
 */
const ISSUED =
  'LOTOU1.01a21a00-0000-7000-8000-000000000013.CbTn_-ylp_QR3iW8z621WT8ZIInTfQh5uZzhbE7a1Rs';

describe('TicketCodeVerifier', () => {
  const verifier = new TicketCodeVerifier(KEY);

  it('aceita o código emitido pelo order-service e devolve o ingresso', () => {
    expect(verifier.verify(ISSUED)).toEqual({ valid: true, ticketId: TICKET });
  });

  it('assina igual ao order-service', () => {
    expect(signTicketCode(KEY, TICKET)).toBe(ISSUED);
  });

  it('recusa o código com o ID trocado e a assinatura de outro ingresso', () => {
    const other = '01a21a00-0000-7000-8000-000000000014';
    const tampered = ISSUED.replace(TICKET, other);
    expect(verifier.verify(tampered)).toEqual({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('recusa o código assinado com outra chave', () => {
    const forged = signTicketCode('uma-chave-que-nao-e-a-da-portaria', TICKET);
    expect(verifier.verify(forged)).toEqual({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('recusa assinatura com um caractere trocado', () => {
    const last = ISSUED.at(-1) === 'A' ? 'B' : 'A';
    expect(verifier.verify(ISSUED.slice(0, -1) + last).valid).toBe(false);
  });

  it.each([
    ['vazio', ''],
    ['texto qualquer', 'https://exemplo.com.br/ingresso'],
    ['sem assinatura', `LOTOU1.${TICKET}`],
    ['assinatura vazia', `LOTOU1.${TICKET}.`],
    ['outra versão do formato', ISSUED.replace('LOTOU1', 'LOTOU2')],
    ['prefixo em minúsculas', ISSUED.replace('LOTOU1', 'lotou1')],
    ['ID que não é UUID', ISSUED.replace(TICKET, 'ingresso-123')],
    ['UUID em maiúsculas', ISSUED.replace(TICKET, TICKET.toUpperCase())],
    ['assinatura curta', ISSUED.slice(0, -1)],
    ['assinatura longa', `${ISSUED}A`],
    ['assinatura com padding', `${ISSUED}=`],
    [
      'base64 comum em vez de base64url',
      `LOTOU1.${TICKET}.${ISSUED.split('.')[2].replace(/[-_]/g, '+')}`,
    ],
    ['espaço no fim', `${ISSUED} `],
    ['quebra de linha no fim', `${ISSUED}\n`],
  ])('recusa código malformado: %s', (_, code) => {
    expect(verifier.verify(code)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  describe('comparação em tempo constante', () => {
    it('compara a assinatura inteira com timingSafeEqual, em buffers de 32 bytes', () => {
      const equals = vi.fn(timingSafeEqual);
      const spied = new TicketCodeVerifier(KEY, equals);

      expect(spied.verify(ISSUED).valid).toBe(true);
      expect(
        spied.verify(signTicketCode('outra-chave-qualquer-123', TICKET)).valid,
      ).toBe(false);

      expect(equals).toHaveBeenCalledTimes(2);
      for (const [expected, given] of equals.mock.calls) {
        expect(expected).toHaveLength(32);
        expect(given).toHaveLength(32);
      }
    });

    it('não compara nada se o código é malformado: não há assinatura para medir', () => {
      const equals = vi.fn(timingSafeEqual);
      new TicketCodeVerifier(KEY, equals).verify(ISSUED.slice(0, -1));
      expect(equals).not.toHaveBeenCalled();
    });

    it('assinatura certa até o penúltimo byte é recusada como qualquer outra', () => {
      const signature = Buffer.from(ISSUED.split('.')[2], 'base64url');
      signature[31] ^= 0xff;
      const almost = `LOTOU1.${TICKET}.${signature.toString('base64url')}`;
      expect(verifier.verify(almost)).toEqual({
        valid: false,
        reason: 'bad-signature',
      });
    });
  });
});
