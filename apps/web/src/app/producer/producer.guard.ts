import { roleGuard } from '../core/auth/role.guard';

/**
 * Telas do produtor. Sem login, leva ao Keycloak e volta à mesma página; com
 * login mas sem o papel `producer`, mostra a tela de acesso restrito.
 */
export const producerGuard = roleGuard('producer', '/painel/sem-acesso');
