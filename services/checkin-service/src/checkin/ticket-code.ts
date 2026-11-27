import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as signWithKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

/**
 * O conteúdo do QR code do ingresso tem duas versões:
 *
 *     LOTOU2.<ticketId>.<base64url sem padding de Ed25519(chave privada, "LOTOU2.<ticketId>")>
 *     LOTOU1.<ticketId>.<base64url sem padding de HMAC-SHA256(chave, "LOTOU1.<ticketId>")>
 *
 * O order-service emite só `LOTOU2` (ADR 38): a assinatura é feita com a chave
 * privada dele, e quem tem só a chave pública (a portaria, e o leitor offline
 * no aparelho) confere o ingresso, mas não consegue criar um. O `LOTOU1`
 * (HMAC, ADR 15) continua aceito aqui, para os ingressos já emitidos; o leitor
 * offline não consegue conferir esse, porque a chave do HMAC não sai do
 * servidor.
 */
const V1 = 'LOTOU1';
const V2 = 'LOTOU2';

export type CodeFormat = typeof V1 | typeof V2;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Prefixo, UUID minúsculo e 43 caracteres de base64url (32 bytes do HMAC). */
const CODE_V1 = new RegExp(`^LOTOU1\\.(${UUID})\\.([A-Za-z0-9_-]{43})$`);
/** Prefixo, UUID minúsculo e 86 caracteres de base64url (64 bytes do Ed25519). */
const CODE_V2 = new RegExp(`^LOTOU2\\.(${UUID})\\.([A-Za-z0-9_-]{86})$`);

const HMAC_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Compara dois buffers do mesmo tamanho; `timingSafeEqual` em produção. */
export type ConstantTimeEquals = (a: Buffer, b: Buffer) => boolean;

export type CodeCheck =
  | { valid: true; ticketId: string; format: CodeFormat }
  /** Malformado ou com a assinatura errada; o motivo só vai para o span. */
  | { valid: false; reason: 'malformed' | 'bad-signature' };

export interface TicketCodeKeys {
  /** `TICKET_QR_KEY`: a chave do HMAC dos códigos `LOTOU1`. */
  hmacKey: string;
  /** `TICKET_PUBLIC_KEY`: a chave pública Ed25519 dos `LOTOU2` (SPKI DER em base64). */
  publicKey: string;
}

/**
 * A chave pública Ed25519 a partir do SPKI DER em base64, como vem em
 * `TICKET_PUBLIC_KEY` (e como o leitor a importa com WebCrypto). Lança se o
 * texto não é uma chave pública Ed25519.
 */
export function ed25519PublicKey(spkiBase64: string): KeyObject {
  const der = Buffer.from(spkiBase64.trim(), 'base64');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `Esperada uma chave Ed25519, recebida ${key.asymmetricKeyType ?? 'desconhecida'}`,
    );
  }
  return key;
}

/**
 * Confere a assinatura do QR code sem consultar nada: um código falsificado é
 * recusado antes de chegar ao banco. No `LOTOU1`, a comparação do HMAC é em
 * tempo constante, para a resposta não dizer quantos bytes da assinatura
 * estavam certos; no `LOTOU2`, quem confere é o `crypto.verify` do Node.
 */
export class TicketCodeVerifier {
  private readonly hmacKey: Buffer;
  private readonly publicKey: KeyObject;

  constructor(
    keys: TicketCodeKeys,
    private readonly equals: ConstantTimeEquals = timingSafeEqual,
  ) {
    this.hmacKey = Buffer.from(keys.hmacKey, 'utf8');
    this.publicKey = ed25519PublicKey(keys.publicKey);
  }

  verify(code: string): CodeCheck {
    if (code.startsWith(`${V2}.`)) {
      return this.verifyV2(code);
    }
    return this.verifyV1(code);
  }

  private verifyV2(code: string): CodeCheck {
    const match = CODE_V2.exec(code);
    if (!match) {
      return { valid: false, reason: 'malformed' };
    }
    const [, ticketId, signature] = match;
    const given = Buffer.from(signature, 'base64url');
    // 86 caracteres são 64 bytes e mais 4 bits que precisam ser zero: só a
    // forma canônica vale, para o mesmo ingresso não ter vários textos de QR.
    if (
      given.length !== ED25519_SIGNATURE_BYTES ||
      given.toString('base64url') !== signature
    ) {
      return { valid: false, reason: 'malformed' };
    }
    const ok = verifySignature(
      null,
      Buffer.from(`${V2}.${ticketId}`, 'utf8'),
      this.publicKey,
      given,
    );
    return ok
      ? { valid: true, ticketId, format: V2 }
      : { valid: false, reason: 'bad-signature' };
  }

  private verifyV1(code: string): CodeCheck {
    const match = CODE_V1.exec(code);
    if (!match) {
      return { valid: false, reason: 'malformed' };
    }
    const [, ticketId, signature] = match;
    const given = Buffer.from(signature, 'base64url');
    // A expressão garante 43 caracteres, que são sempre 32 bytes; a conferência
    // fica para o `timingSafeEqual` nunca receber tamanhos diferentes.
    if (given.length !== HMAC_BYTES) {
      return { valid: false, reason: 'malformed' };
    }
    const expected = hmac(this.hmacKey, ticketId);
    return this.equals(expected, given)
      ? { valid: true, ticketId, format: V1 }
      : { valid: false, reason: 'bad-signature' };
  }
}

function hmac(key: Buffer, ticketId: string): Buffer {
  return createHmac('sha256', key).update(`${V1}.${ticketId}`, 'utf8').digest();
}

/**
 * O código `LOTOU2` de um ingresso, como o order-service o emite. A portaria
 * não emite ingressos; os testes usam esta função, com um par de chaves
 * gerado na hora, para montar QR codes válidos. `privateKey` é um `KeyObject`
 * ou o PKCS#8 DER em base64.
 */
export function signTicketCode(
  privateKey: KeyObject | string,
  ticketId: string,
): string {
  const key =
    typeof privateKey === 'string'
      ? createPrivateKey({
          key: Buffer.from(privateKey, 'base64'),
          format: 'der',
          type: 'pkcs8',
        })
      : privateKey;
  const signature = signWithKey(
    null,
    Buffer.from(`${V2}.${ticketId}`, 'utf8'),
    key,
  ).toString('base64url');
  return `${V2}.${ticketId}.${signature}`;
}

/** O código `LOTOU1` (HMAC) de um ingresso emitido antes do `LOTOU2`; só para testes. */
export function signLegacyTicketCode(key: string, ticketId: string): string {
  const signature = hmac(Buffer.from(key, 'utf8'), ticketId).toString(
    'base64url',
  );
  return `${V1}.${ticketId}.${signature}`;
}
