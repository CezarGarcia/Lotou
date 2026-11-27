import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { Env } from '../config/env.js';
import { Problems } from '../common/problem/problem.js';
import {
  type AuthenticatedUser,
  ROLES,
  type Role,
} from './authenticated-user.js';

/** Token de injeção do conjunto de chaves públicas (JWKS) do emissor. */
export const JWT_KEY_SET = Symbol('JWT_KEY_SET');

const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);

/**
 * Valida o JWT emitido pelo Keycloak: assinatura (pela chave pública do
 * realm), emissor, audiência e validade. A validação é local, sem chamada ao
 * Keycloak por requisição; as chaves ficam em cache e são rebuscadas quando
 * aparece um `kid` desconhecido (rotação de chaves).
 */
@Injectable()
export class TokenVerifier {
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    @Inject(JWT_KEY_SET) private readonly keySet: JWTVerifyGetKey,
    config: ConfigService<Env, true>,
  ) {
    this.issuer = config.get('AUTH_ISSUER', { infer: true });
    this.audience = config.get('AUTH_AUDIENCE', { infer: true });
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    try {
      const { payload } = await jwtVerify(token, this.keySet, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp'],
      });
      const realmAccess = payload.realm_access as
        { roles?: unknown } | undefined;
      const roles = Array.isArray(realmAccess?.roles)
        ? realmAccess.roles.filter(isRole)
        : [];
      return { id: payload.sub!, roles };
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        throw Problems.unauthorized('O token expirou.');
      }
      if (error instanceof errors.JOSEError) {
        throw Problems.unauthorized('O token é inválido.');
      }
      // Falha ao buscar as chaves (Keycloak fora do ar): não é culpa do cliente.
      throw error;
    }
  }
}
