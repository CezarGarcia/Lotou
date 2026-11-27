/**
 * Papéis do realm `lotou` no Keycloak (ADR 19). `service` é o papel das
 * contas de serviço: identifica uma chamada feita por outro serviço do Lotou,
 * sem usuário (ADR 21).
 */
export const ROLES = ['buyer', 'producer', 'gate-staff', 'service'] as const;
export type Role = (typeof ROLES)[number];

/** Quem está chamando, extraído do JWT já validado. */
export interface AuthenticatedUser {
  /** Claim `sub`: o ID do usuário no Keycloak. */
  id: string;
  roles: Role[];
}
