import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose';
import { randomUUID } from 'node:crypto';
import type { Role } from '../../src/auth/authenticated-user.js';

/**
 * Um emissor de tokens de teste: faz o papel do Keycloak. Gera um par de
 * chaves RSA, assina JWTs com o mesmo formato do realm e expõe a chave pública
 * para a aplicação validar.
 */
export interface TestIssuer {
  keySet: JWTVerifyGetKey;
  token(claims?: TokenClaims): Promise<string>;
}

export interface TokenClaims {
  sub?: string;
  roles?: Role[];
  issuer?: string;
  audience?: string;
  /** Segundos a partir de agora; negativo gera um token já expirado. */
  expiresIn?: number;
}

export async function createTestIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const kid = randomUUID();
  const keySet = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }],
  });

  return {
    keySet,
    token: ({
      sub = randomUUID(),
      roles = [],
      issuer = process.env.AUTH_ISSUER!,
      audience = process.env.AUTH_AUDIENCE!,
      expiresIn = 300,
    } = {}) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ realm_access: { roles } })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setSubject(sub)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt(now - 600)
        .setExpirationTime(now + expiresIn)
        .sign(privateKey);
    },
  };
}
