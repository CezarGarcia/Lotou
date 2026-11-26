/** Papéis do realm usados pela loja. */
export type Role = 'buyer' | 'producer' | 'gate-staff';

/** Payload de um JWT, sem conferir a assinatura (quem confere é o gateway). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split('.')[1];
  if (!payload) {
    return null;
  }
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Papéis do realm, na claim `realm_access.roles` do access token. */
export function rolesFromAccessToken(token: string | null | undefined): string[] {
  const realmAccess = token ? decodeJwtPayload(token)?.['realm_access'] : undefined;
  const roles = (realmAccess as { roles?: unknown } | undefined)?.roles;
  return Array.isArray(roles)
    ? roles.filter((role): role is string => typeof role === 'string')
    : [];
}

/** O primeiro nome para o cabeçalho: `given_name`, ou o começo de `name`. */
export function firstNameOf(claims: unknown): string {
  if (typeof claims !== 'object' || claims === null) {
    return '';
  }
  const {
    given_name: given,
    name,
    preferred_username: username,
  } = claims as Record<string, unknown>;
  const text = [given, name, username].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  return text?.trim().split(/\s+/)[0] ?? '';
}

/**
 * Só caminhos internos (`/pedidos/1`) servem de volta do login. Uma URL
 * absoluta ou `//outro.site` levaria o comprador para fora da loja.
 */
export function safeReturnUrl(url: string | null | undefined): string | null {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') ? url : null;
}
