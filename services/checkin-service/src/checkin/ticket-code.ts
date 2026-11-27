import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * O conteúdo do QR code do ingresso (ADR 15):
 *
 *     LOTOU1.<ticketId>.<base64url sem padding de HMAC-SHA256(chave, "LOTOU1.<ticketId>")>
 *
 * O mesmo formato do `TicketCodes` do order-service, que emite o código. O
 * prefixo versiona o formato: uma troca de chave ou de algoritmo vira
 * `LOTOU2`, e esta classe passa a aceitar as duas enquanto houver ingresso
 * antigo válido.
 */
const PREFIX = 'LOTOU1';

/** O código inteiro: prefixo, UUID minúsculo e 43 caracteres de base64url (32 bytes). */
const CODE =
  /^LOTOU1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

const HMAC_BYTES = 32;

/** Compara dois buffers do mesmo tamanho; `timingSafeEqual` em produção. */
export type ConstantTimeEquals = (a: Buffer, b: Buffer) => boolean;

export type CodeCheck =
  | { valid: true; ticketId: string }
  /** Malformado ou com a assinatura errada; o motivo só vai para o span. */
  | { valid: false; reason: 'malformed' | 'bad-signature' };

/**
 * Confere a assinatura do QR code sem consultar nada: um código falsificado é
 * recusado antes de chegar ao banco. A comparação é em tempo constante, para
 * a resposta não dizer quantos bytes da assinatura estavam certos.
 */
export class TicketCodeVerifier {
  private readonly key: Buffer;

  constructor(
    key: string,
    private readonly equals: ConstantTimeEquals = timingSafeEqual,
  ) {
    this.key = Buffer.from(key, 'utf8');
  }

  verify(code: string): CodeCheck {
    const match = CODE.exec(code);
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
    const expected = sign(this.key, ticketId);
    return this.equals(expected, given)
      ? { valid: true, ticketId }
      : { valid: false, reason: 'bad-signature' };
  }
}

function sign(key: Buffer, ticketId: string): Buffer {
  return createHmac('sha256', key)
    .update(`${PREFIX}.${ticketId}`, 'utf8')
    .digest();
}

/**
 * O código de um ingresso, como o order-service o emite. A portaria não emite
 * ingressos; os testes usam esta função para montar QR codes válidos.
 */
export function signTicketCode(key: string, ticketId: string): string {
  const signature = sign(Buffer.from(key, 'utf8'), ticketId).toString(
    'base64url',
  );
  return `${PREFIX}.${ticketId}.${signature}`;
}
