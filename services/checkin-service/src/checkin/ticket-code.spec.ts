import { generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import {
  ed25519PublicKey,
  signLegacyTicketCode,
  signTicketCode,
  TicketCodeVerifier,
} from './ticket-code.js';

const KEY = 'lotou-dev-ticket-qr-key';
const TICKET = '01a21a00-0000-7000-8000-000000000013';
/**
 * Calculado fora do Node (Python, `hmac` + `base64.urlsafe_b64encode`), como o
 * `TicketCodes` do order-service calcula: HMAC-SHA256 de `LOTOU1.<id>`.
 */
const ISSUED =
  'LOTOU1.01a21a00-0000-7000-8000-000000000013.CbTn_-ylp_QR3iW8z621WT8ZIInTfQh5uZzhbE7a1Rs';

/**
 * Par de chaves do vetor de teste 1 da RFC 8032 (nunca usado fora daqui), e a
 * assinatura de `LOTOU2.<TICKET>` calculada fora do Node, com o OpenSSL
 * (`openssl pkeyutl -sign -rawin`): o Ed25519 é determinístico, então o
 * order-service (Java) e o WebCrypto do leitor chegam ao mesmo texto.
 */
const RFC8032_PRIVATE_KEY =
  'MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g';
const RFC8032_PUBLIC_KEY =
  'MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
const ISSUED_V2 =
  'LOTOU2.01a21a00-0000-7000-8000-000000000013.Fz7GZYZ8HncF540IkMwlSWHT12UYLzwPkLIsTz5MXcm46er6srzRxYudl4QkGoa_ujS0Q3o_LPIa_OR9SImEAA';

const spki = (key: ReturnType<typeof generateKeyPairSync>['publicKey']) =>
  key.export({ format: 'der', type: 'spki' }).toString('base64');

describe('TicketCodeVerifier', () => {
  const verifier = new TicketCodeVerifier({
    hmacKey: KEY,
    publicKey: RFC8032_PUBLIC_KEY,
  });

  describe('LOTOU2 (Ed25519)', () => {
    it('aceita o código assinado com a chave privada e devolve o ingresso', () => {
      expect(verifier.verify(ISSUED_V2)).toEqual({
        valid: true,
        ticketId: TICKET,
        format: 'LOTOU2',
      });
    });

    it('assina igual ao OpenSSL (Ed25519 é determinístico)', () => {
      expect(signTicketCode(RFC8032_PRIVATE_KEY, TICKET)).toBe(ISSUED_V2);
    });

    it('confere com um par de chaves gerado na hora', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const own = new TicketCodeVerifier({
        hmacKey: KEY,
        publicKey: spki(publicKey),
      });
      const code = signTicketCode(privateKey, TICKET);
      expect(code).toMatch(/^LOTOU2\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{86}$/);
      expect(own.verify(code)).toEqual({
        valid: true,
        ticketId: TICKET,
        format: 'LOTOU2',
      });
      // A outra chave não confere este código.
      expect(verifier.verify(code)).toEqual({
        valid: false,
        reason: 'bad-signature',
      });
    });

    it('recusa o código com o ID trocado e a assinatura de outro ingresso', () => {
      const other = '01a21a00-0000-7000-8000-000000000014';
      expect(verifier.verify(ISSUED_V2.replace(TICKET, other))).toEqual({
        valid: false,
        reason: 'bad-signature',
      });
    });

    it('recusa assinatura com um byte trocado', () => {
      const signature = Buffer.from(ISSUED_V2.split('.')[2], 'base64url');
      signature[10] ^= 0x01;
      const tampered = `LOTOU2.${TICKET}.${signature.toString('base64url')}`;
      expect(verifier.verify(tampered)).toEqual({
        valid: false,
        reason: 'bad-signature',
      });
    });

    it('a assinatura HMAC certa no formato LOTOU2 não vale', () => {
      const hmac = signLegacyTicketCode(KEY, TICKET).split('.')[2];
      expect(verifier.verify(`LOTOU2.${TICKET}.${hmac}`).valid).toBe(false);
    });

    it.each([
      ['sem assinatura', `LOTOU2.${TICKET}`],
      ['assinatura curta', ISSUED_V2.slice(0, -1)],
      ['assinatura longa', `${ISSUED_V2}A`],
      ['assinatura com padding', `${ISSUED_V2}==`],
      // O último caractere carrega 2 bits; `AB` decodifica nos mesmos 64
      // bytes, mas não é a forma canônica.
      ['base64url fora da forma canônica', `${ISSUED_V2.slice(0, -1)}B`],
      ['UUID em maiúsculas', ISSUED_V2.replace(TICKET, TICKET.toUpperCase())],
      ['espaço no fim', `${ISSUED_V2} `],
    ])('recusa código malformado: %s', (_, code) => {
      expect(verifier.verify(code)).toEqual({
        valid: false,
        reason: 'malformed',
      });
    });
  });

  it('não sobe com uma chave pública que não é Ed25519', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(
      () =>
        new TicketCodeVerifier({ hmacKey: KEY, publicKey: spki(publicKey) }),
    ).toThrow(/Ed25519/);
    expect(() => ed25519PublicKey('não é base64 de chave')).toThrow();
  });

  it('LOTOU1: aceita o código emitido antes do LOTOU2 e devolve o ingresso', () => {
    expect(verifier.verify(ISSUED)).toEqual({
      valid: true,
      ticketId: TICKET,
      format: 'LOTOU1',
    });
  });

  it('LOTOU1: assina igual ao order-service', () => {
    expect(signLegacyTicketCode(KEY, TICKET)).toBe(ISSUED);
  });

  it('LOTOU1: recusa o código com o ID trocado e a assinatura de outro ingresso', () => {
    const other = '01a21a00-0000-7000-8000-000000000014';
    const tampered = ISSUED.replace(TICKET, other);
    expect(verifier.verify(tampered)).toEqual({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('LOTOU1: recusa o código assinado com outra chave', () => {
    const forged = signLegacyTicketCode(
      'uma-chave-que-nao-e-a-da-portaria',
      TICKET,
    );
    expect(verifier.verify(forged)).toEqual({
      valid: false,
      reason: 'bad-signature',
    });
  });

  it('LOTOU1: recusa assinatura com um caractere trocado', () => {
    const last = ISSUED.at(-1) === 'A' ? 'B' : 'A';
    expect(verifier.verify(ISSUED.slice(0, -1) + last).valid).toBe(false);
  });

  it.each([
    ['vazio', ''],
    ['texto qualquer', 'https://exemplo.com.br/ingresso'],
    ['sem assinatura', `LOTOU1.${TICKET}`],
    ['assinatura vazia', `LOTOU1.${TICKET}.`],
    ['outra versão do formato', ISSUED.replace('LOTOU1', 'LOTOU3')],
    [
      'assinatura HMAC com o prefixo LOTOU2',
      ISSUED.replace('LOTOU1', 'LOTOU2'),
    ],
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
  ])('LOTOU1: recusa código malformado: %s', (_, code) => {
    expect(verifier.verify(code)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  describe('LOTOU1: comparação em tempo constante', () => {
    it('compara a assinatura inteira com timingSafeEqual, em buffers de 32 bytes', () => {
      const equals = vi.fn(timingSafeEqual);
      const spied = new TicketCodeVerifier(
        { hmacKey: KEY, publicKey: RFC8032_PUBLIC_KEY },
        equals,
      );

      expect(spied.verify(ISSUED).valid).toBe(true);
      expect(
        spied.verify(signLegacyTicketCode('outra-chave-qualquer-123', TICKET))
          .valid,
      ).toBe(false);

      expect(equals).toHaveBeenCalledTimes(2);
      for (const [expected, given] of equals.mock.calls) {
        expect(expected).toHaveLength(32);
        expect(given).toHaveLength(32);
      }
    });

    it('não compara nada se o código é malformado: não há assinatura para medir', () => {
      const equals = vi.fn(timingSafeEqual);
      new TicketCodeVerifier(
        { hmacKey: KEY, publicKey: RFC8032_PUBLIC_KEY },
        equals,
      ).verify(ISSUED.slice(0, -1));
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
