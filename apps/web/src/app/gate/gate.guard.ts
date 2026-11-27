import { roleGuard } from '../core/auth/role.guard';

/**
 * Telas da portaria. Sem login, leva ao Keycloak e volta à mesma página; com
 * login mas sem o papel `gate-staff`, mostra a tela de acesso restrito. Quem
 * protege os dados é o servidor: o gateway e o checkin-service conferem o papel.
 */
export const gateGuard = roleGuard('gate-staff', '/portaria/sem-acesso');
