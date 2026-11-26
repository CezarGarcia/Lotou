/** Cabeçalho que a API exige nos POST que criam recurso. */
export const IDEMPOTENCY_KEY = 'Idempotency-Key';

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * UUID v7 (RFC 9562): 48 bits de milissegundos e o resto aleatório, como os IDs
 * do Lotou. Usa `getRandomValues`, que existe também fora de HTTPS (ao contrário
 * de `crypto.randomUUID`).
 */
export function uuidv7(nowMs = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Math.floor(nowMs / 2 ** (8 * (5 - i))) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const text = hex(bytes);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/**
 * A chave de idempotência de uma tentativa de compra.
 *
 * Repetir o mesmo pedido depois de uma falha passageira (rede, 503) reaproveita
 * a chave: se a primeira requisição chegou a reservar, o servidor devolve a
 * mesma reserva em vez de reservar de novo. Mudar o pedido (outra quantidade,
 * outras cadeiras) ou receber uma resposta definitiva começa uma tentativa nova.
 */
export class AttemptKey {
  private current?: { key: string; request: string };

  /** A chave para este corpo de requisição. */
  for(body: unknown): string {
    const request = JSON.stringify(body);
    if (this.current?.request !== request) {
      this.current = { key: uuidv7(), request };
    }
    return this.current.key;
  }

  /** Encerra a tentativa: o próximo envio, mesmo igual, leva uma chave nova. */
  reset(): void {
    this.current = undefined;
  }
}
