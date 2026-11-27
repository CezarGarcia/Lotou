import { checkOffline, OfflineCheck } from './offline-check';
import { doorsOpenAtOf, sectorsOf, toOfflinePackage } from './offline-package';
import { CAMAROTE, PISTA, T1, T2, testKeys, testPackage, ticket } from './offline.testing';
import { parseTicketCode, webCryptoVerifier } from './ticket-code';

const NOW = Date.parse('2026-12-16T23:30:00Z');
const code = (ticketId = T1) => parseTicketCode(`LOTOU1.${ticketId}.${'a'.repeat(43)}`);

const check = (value: Partial<OfflineCheck> = {}) =>
  checkOffline({
    code: code(),
    signatureValid: null,
    ticket: ticket(T1),
    entry: undefined,
    sectors: [],
    doorsOpenAt: '2026-12-16T21:00:00Z',
    now: NOW,
    ...value,
  });

describe('parseTicketCode', () => {
  it('separa o LOTOU2 na parte assinada e na assinatura', () => {
    const signature = 'x'.repeat(86);
    expect(parseTicketCode(`LOTOU2.${T1}.${signature}`)).toEqual({
      version: 2,
      ticketId: T1,
      signed: `LOTOU2.${T1}`,
      signature,
    });
  });

  it('reconhece o LOTOU1 antigo e recusa o resto', () => {
    expect(code()).toEqual({ version: 1, ticketId: T1 });
    expect(parseTicketCode(`LOTOU2.${T1}.curta`)).toBeNull();
    expect(parseTicketCode(`LOTOU3.${T1}.${'x'.repeat(86)}`)).toBeNull();
    expect(parseTicketCode(`LOTOU2.${T1.toUpperCase()}.${'x'.repeat(86)}`)).toBeNull();
    expect(parseTicketCode('qualquer coisa')).toBeNull();
  });
});

describe('webCryptoVerifier', () => {
  it('confere a assinatura Ed25519 com a chave pública do pacote', async () => {
    const keys = await testKeys();
    const verify = webCryptoVerifier(globalThis.crypto.subtle);
    const parsed = parseTicketCode(await keys.code(T1));
    expect(parsed?.version).toBe(2);
    if (parsed?.version !== 2) return;
    expect(await verify(keys.publicKey, parsed.signed, parsed.signature)).toBe(true);
    // A mesma assinatura em outro ingresso, ou com a chave de outro emissor, não vale.
    expect(await verify(keys.publicKey, `LOTOU2.${T2}`, parsed.signature)).toBe(false);
    const other = await testKeys();
    expect(await verify(other.publicKey, parsed.signed, parsed.signature)).toBe(false);
  });

  it('sem WebCrypto (página fora de HTTPS), avisa que não dá para conferir', async () => {
    await expect(webCryptoVerifier(undefined)('chave', 'm', 's')).rejects.toThrow();
  });
});

describe('checkOffline', () => {
  it('libera o ingresso válido, com o setor', () => {
    expect(check()).toEqual({
      result: 'ACCEPTED',
      ticket: { ticketId: T1, sectorName: 'Pista', seat: null },
      firstEntry: null,
    });
  });

  it('recusa código que não é do Lotou e assinatura errada', () => {
    expect(check({ code: null }).result).toBe('INVALID_CODE');
    const v2 = parseTicketCode(`LOTOU2.${T1}.${'x'.repeat(86)}`);
    expect(check({ code: v2, signatureValid: false }).result).toBe('INVALID_CODE');
    expect(check({ code: v2, signatureValid: true }).result).toBe('ACCEPTED');
  });

  it('ingresso fora do pacote é desconhecido (outro show também)', () => {
    expect(check({ ticket: undefined }).result).toBe('UNKNOWN_TICKET');
  });

  it('cancelado barra', () => {
    expect(check({ ticket: ticket(T1, { status: 'CANCELLED' }) }).result).toBe('CANCELLED');
  });

  it('já usado pelo servidor ou neste aparelho, com a primeira entrada', () => {
    const used = ticket(T1, { status: 'USED', usedAt: '2026-12-16T23:10:00Z', gate: 'Portão B' });
    expect(check({ ticket: used })).toMatchObject({
      result: 'ALREADY_USED',
      firstEntry: { at: '2026-12-16T23:10:00Z', gate: 'Portão B' },
    });
    const entry = { showId: 's1', ticketId: T1, at: '2026-12-16T23:20:00Z', gate: 'Portão A' };
    expect(check({ entry })).toMatchObject({
      result: 'ALREADY_USED',
      firstEntry: { at: entry.at, gate: 'Portão A' },
    });
    // As duas: vale a mais antiga.
    expect(check({ ticket: used, entry }).firstEntry?.gate).toBe('Portão B');
    // Usado sem saber onde.
    expect(check({ ticket: ticket(T1, { status: 'USED' }) }).firstEntry).toBeNull();
  });

  it('setor que o portão não atende vira "setor de outro portão"', () => {
    expect(check({ sectors: [CAMAROTE] })).toMatchObject({
      result: 'WRONG_SECTOR',
      ticket: { sectorName: 'Pista' },
    });
    expect(check({ sectors: [CAMAROTE, PISTA] }).result).toBe('ACCEPTED');
  });

  it('antes da abertura dos portões, barra', () => {
    expect(check({ now: Date.parse('2026-12-16T20:59:59Z') }).result).toBe('NOT_OPEN');
  });
});

describe('pacote offline', () => {
  it('lê o pacote e descarta o que não serve', () => {
    const raw = {
      ...testPackage('chave'),
      tickets: [
        { id: T1.toUpperCase(), sectorId: PISTA, sectorName: 'Pista', seat: null, status: 'VALID' },
        { id: T2, status: 'OUTRO' },
        { id: T2, sectorId: PISTA, sectorName: 'Pista', status: 'USED', usedAt: 'x', gate: 'B' },
        null,
      ],
    };
    const pkg = toOfflinePackage(raw)!;
    expect(pkg.tickets).toEqual([
      ticket(T1),
      ticket(T2, { status: 'USED', usedAt: 'x', gate: 'B' }),
    ]);
    expect(toOfflinePackage({ ...raw, publicKey: '' })).toBeNull();
    expect(toOfflinePackage('nada')).toBeNull();
  });

  it('sem abertura definida, os portões abrem no começo do dia do show no fuso do local', () => {
    // Show às 23h30 de Belém (UTC-3) é 2h30 do dia seguinte em UTC.
    const show = { doorsOpenAt: null, startsAt: '2026-11-28T02:30:00Z', timezone: 'America/Belem' };
    expect(doorsOpenAtOf(show)).toBe('2026-11-27T03:00:00.000Z');
    expect(doorsOpenAtOf({ ...show, doorsOpenAt: '2026-11-27T20:00:00Z' })).toBe(
      '2026-11-27T20:00:00Z',
    );
  });

  it('lista os setores do pacote em ordem', () => {
    expect(sectorsOf(testPackage('chave'))).toEqual([
      { id: CAMAROTE, name: 'Camarote' },
      { id: PISTA, name: 'Pista' },
    ]);
    expect(sectorsOf(null)).toEqual([]);
  });
});
