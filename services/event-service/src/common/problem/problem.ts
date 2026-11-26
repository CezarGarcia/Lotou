import { HttpException, HttpStatus } from '@nestjs/common';

/** Tipo de conteúdo dos erros da API (RFC 9457, Problem Details). */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Um campo ou uma regra que impediu a requisição. */
export interface ProblemViolation {
  /** Caminho do campo no corpo ou na query, ex.: `sectors.0.lots.1.quantity`. */
  field: string;
  message: string;
}

export interface ProblemDetails {
  /** Identifica o tipo do problema; estável, para o cliente tratar por código. */
  type: string;
  /** Resumo curto do tipo, igual em toda ocorrência. */
  title: string;
  status: number;
  /** Explicação desta ocorrência. */
  detail?: string;
  /** Caminho da requisição que falhou. */
  instance?: string;
  /** ID do trace, para achar a requisição no Tempo. */
  traceId?: string;
  errors?: ProblemViolation[];
}

const problemType = (slug: string) => `urn:lotou:problem:${slug}`;

export interface ProblemInit {
  status: HttpStatus;
  /** Sufixo do `type`, ex.: `show-not-publishable`. */
  slug: string;
  title: string;
  detail?: string;
  errors?: ProblemViolation[];
  /** Cabeçalhos extras da resposta, ex.: `WWW-Authenticate`. */
  headers?: Record<string, string>;
}

/** Erro de API com tipo próprio. O filtro global o converte em Problem Details. */
export class ProblemException extends HttpException {
  readonly headers: Record<string, string>;

  constructor({ status, slug, title, detail, errors, headers }: ProblemInit) {
    const body: ProblemDetails = {
      type: problemType(slug),
      title,
      status,
      ...(detail && { detail }),
      ...(errors?.length && { errors }),
    };
    super(body, status);
    this.headers = headers ?? {};
  }

  get problem(): ProblemDetails {
    return this.getResponse() as ProblemDetails;
  }
}

/** Problemas usados por mais de um módulo. */
export const Problems = {
  validation: (errors: ProblemViolation[]) =>
    new ProblemException({
      status: HttpStatus.BAD_REQUEST,
      slug: 'validation-error',
      title: 'Requisição inválida',
      detail: 'Um ou mais campos da requisição são inválidos.',
      errors,
    }),

  unauthorized: (detail: string) =>
    new ProblemException({
      status: HttpStatus.UNAUTHORIZED,
      slug: 'unauthorized',
      title: 'Não autenticado',
      detail,
      headers: { 'WWW-Authenticate': 'Bearer' },
    }),

  forbidden: () =>
    new ProblemException({
      status: HttpStatus.FORBIDDEN,
      slug: 'forbidden',
      title: 'Acesso negado',
      detail: 'Seu usuário não tem permissão para esta operação.',
    }),

  notFound: (resource: string) =>
    new ProblemException({
      status: HttpStatus.NOT_FOUND,
      slug: 'not-found',
      title: 'Recurso não encontrado',
      detail: `${resource} não encontrado.`,
    }),

  businessRule: (errors: ProblemViolation[]) =>
    new ProblemException({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      slug: 'business-rule-violation',
      title: 'Regra de negócio violada',
      detail: 'A requisição é válida, mas fere uma regra do produto.',
      errors,
    }),

  versionConflict: (resource: string) =>
    new ProblemException({
      status: HttpStatus.CONFLICT,
      slug: 'version-conflict',
      title: 'Conflito de versão',
      detail: `${resource} foi alterado por outra requisição. Leia de novo e repita a operação.`,
    }),
} as const;
