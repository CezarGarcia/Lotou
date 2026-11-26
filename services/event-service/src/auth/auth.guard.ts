import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Problems } from '../common/problem/problem.js';
import {
  IS_PUBLIC_KEY,
  type RequestWithUser,
  ROLES_KEY,
} from './auth.decorators.js';
import type { Role } from './authenticated-user.js';
import { TokenVerifier } from './token-verifier.js';

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Guard global de autenticação e autorização.
 *
 * O gateway já valida o JWT, mas o serviço valida de novo (ADR 21): ele não
 * confia na rede, e precisa do `sub` e dos papéis para as regras de dono.
 *
 * - Sem token: só passa em rota `@Public()`.
 * - Com token: sempre validado, mesmo em rota pública (token ruim é 401).
 * - Com `@Roles()`: o usuário precisa ter ao menos um dos papéis (senão 403).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenVerifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      targets,
    );
    const requiredRoles =
      this.reflector.getAllAndOverride<Role[] | undefined>(
        ROLES_KEY,
        targets,
      ) ?? [];

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const authorization = request.headers.authorization;

    if (!authorization) {
      if (isPublic) {
        return true;
      }
      throw Problems.unauthorized('Envie o token no cabeçalho Authorization.');
    }

    const token = BEARER.exec(authorization)?.[1];
    if (!token) {
      throw Problems.unauthorized(
        'O cabeçalho Authorization deve usar o esquema Bearer.',
      );
    }

    const user = await this.tokenVerifier.verify(token);
    request.user = user;

    if (
      requiredRoles.length > 0 &&
      !requiredRoles.some((role) => user.roles.includes(role))
    ) {
      throw Problems.forbidden();
    }
    return true;
  }
}
