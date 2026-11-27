import { InjectionToken } from '@angular/core';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** `LOTOU2.<ticketId>.<Ed25519 em base64url sem padding>` (64 bytes = 86 caracteres). */
const LOTOU2 = new RegExp(`^(LOTOU2\\.(${UUID}))\\.([A-Za-z0-9_-]{86})$`);
/** `LOTOU1.<ticketId>.<HMAC-SHA256 em base64url sem padding>` (32 bytes = 43 caracteres). */
const LOTOU1 = new RegExp(`^LOTOU1\\.(${UUID})\\.[A-Za-z0-9_-]{43}$`);

/** O QR de um ingresso, separado em partes; `null` se não é um código do Lotou. */
export type TicketCode =
  | { version: 2; ticketId: string; signed: string; signature: string }
  | { version: 1; ticketId: string };

export function parseTicketCode(code: string): TicketCode | null {
  const v2 = LOTOU2.exec(code);
  if (v2) {
    return { version: 2, ticketId: v2[2], signed: v2[1], signature: v2[3] };
  }
  const v1 = LOTOU1.exec(code);
  return v1 ? { version: 1, ticketId: v1[1] } : null;
}

/**
 * Confere a assinatura Ed25519 de `message` com a chave pública (SPKI DER em
 * base64). `true` ou `false` quando dá para conferir; lança quando o
 * navegador não sabe Ed25519 (ou a página não está em HTTPS, onde o
 * `crypto.subtle` não existe).
 */
export type SignatureVerifier = (
  publicKey: string,
  message: string,
  signature: string,
) => Promise<boolean>;

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** A verificação com o WebCrypto do navegador. A chave importada fica guardada. */
export function webCryptoVerifier(subtle: SubtleCrypto | undefined): SignatureVerifier {
  const keys = new Map<string, Promise<CryptoKey>>();
  return async (publicKey, message, signature) => {
    if (!subtle) {
      throw new Error('WebCrypto indisponível');
    }
    let key = keys.get(publicKey);
    if (!key) {
      key = subtle.importKey('spki', base64ToBytes(publicKey), { name: 'Ed25519' }, false, [
        'verify',
      ]);
      keys.set(publicKey, key);
      key.catch(() => keys.delete(publicKey));
    }
    return subtle.verify(
      { name: 'Ed25519' },
      await key,
      base64ToBytes(signature),
      new TextEncoder().encode(message),
    );
  };
}

/** Como o leitor confere o QR sem internet; trocável nos testes. */
export const SIGNATURE_VERIFIER = new InjectionToken<SignatureVerifier>('SIGNATURE_VERIFIER', {
  providedIn: 'root',
  factory: () => webCryptoVerifier(globalThis.crypto?.subtle),
});
