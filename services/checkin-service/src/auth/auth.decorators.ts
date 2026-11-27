import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser, Role } from './authenticated-user.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';

/**
 * Libera a rota para quem não está autenticado. Sem este decorator, toda rota
 * exige um token válido: esquecer de proteger uma rota nova não a expõe.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Exige que o usuário tenha ao menos um dos papéis. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export type RequestWithUser = Request & { user?: AuthenticatedUser };

/**
 * O usuário autenticado. Em rota `@Public()` vem `undefined` quando a
 * requisição não trouxe token.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<RequestWithUser>().user,
);
