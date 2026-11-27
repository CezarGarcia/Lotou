import { OfflinePackage, OfflineTicket } from './offline-package';

const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const base64url = (bytes: ArrayBuffer) =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Um par de chaves Ed25519 gerado na hora, como o do order-service, e quem assina os QR. */
export interface TestKeys {
  /** SPKI DER em base64, como vem no pacote. */
  publicKey: string;
  /** O QR `LOTOU2` de um ingresso, assinado com a chave privada. */
  code(ticketId: string): Promise<string>;
}

export async function testKeys(): Promise<TestKeys> {
  const subtle = globalThis.crypto.subtle;
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    publicKey: base64(await subtle.exportKey('spki', pair.publicKey)),
    async code(ticketId: string) {
      const signed = `LOTOU2.${ticketId}`;
      const signature = await subtle.sign(
        { name: 'Ed25519' },
        pair.privateKey,
        new TextEncoder().encode(signed),
      );
      return `${signed}.${base64url(signature)}`;
    },
  };
}

/**
 * Nos testes das telas, a assinatura é conferida sem WebCrypto (que responde
 * fora do relógio falso do Vitest): vale a assinatura `GOOD_SIGNATURE`. A
 * conferência de verdade, com Ed25519, tem os próprios testes.
 */
export const GOOD_SIGNATURE = 's'.repeat(86);
export const fakeVerifier = async (_key: string, _message: string, signature: string) =>
  signature === GOOD_SIGNATURE;
export const signedCode = (ticketId: string, signature = GOOD_SIGNATURE) =>
  `LOTOU2.${ticketId}.${signature}`;

/** Ids de ingresso no formato do Lotou (UUID minúsculo). */
export const T1 = '0192a1b2-c3d4-7e5f-8a9b-000000000001';
export const T2 = '0192a1b2-c3d4-7e5f-8a9b-000000000002';
export const T3 = '0192a1b2-c3d4-7e5f-8a9b-000000000003';
export const T4 = '0192a1b2-c3d4-7e5f-8a9b-000000000004';
export const PISTA = 'sector-pista';
export const CAMAROTE = 'sector-camarote';

export const ticket = (id: string, value: Partial<OfflineTicket> = {}): OfflineTicket => ({
  id,
  sectorId: PISTA,
  sectorName: 'Pista',
  seat: null,
  status: 'VALID',
  ...value,
});

/**
 * Um pacote de teste do show `s1`: portões abertos às 18:00 de Recife, um
 * ingresso válido na pista (T1), um usado (T2), um cancelado (T3) e um no
 * camarote (T4).
 */
export function testPackage(
  publicKey: string,
  value: Partial<OfflinePackage> = {},
): OfflinePackage {
  return {
    showId: 's1',
    generatedAt: '2026-12-16T23:31:04.120Z',
    publicKey,
    doorsOpenAt: '2026-12-16T21:00:00Z',
    startsAt: '2026-12-17T00:00:00Z',
    timezone: 'America/Recife',
    tickets: [
      ticket(T1),
      ticket(T2, { status: 'USED', usedAt: '2026-12-16T23:10:00Z', gate: 'Portão A' }),
      ticket(T3, { status: 'CANCELLED' }),
      ticket(T4, { sectorId: CAMAROTE, sectorName: 'Camarote', seat: 'A-5' }),
    ],
    ...value,
  };
}
