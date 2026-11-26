/** Papéis do realm `lotou` no Keycloak (ADR 19). */
export const ROLES = ['buyer', 'producer', 'gate-staff'] as const;
export type Role = (typeof ROLES)[number];

/** Quem está chamando, extraído do JWT já validado. */
export interface AuthenticatedUser {
  /** Claim `sub`: o ID do usuário no Keycloak. */
  id: string;
  roles: Role[];
}
