import { StandardSchemaValidationPipe } from '@nestjs/common';
import { Problems } from './problem.js';

type Issue = Parameters<
  NonNullable<
    NonNullable<
      ConstructorParameters<typeof StandardSchemaValidationPipe>[0]
    >['exceptionFactory']
  >
>[0][number];

const fieldOf = (issue: Issue): string =>
  (issue.path ?? [])
    .map((segment) =>
      typeof segment === 'object' ? String(segment.key) : String(segment),
    )
    .join('.');

/**
 * Pipe global de validação. Valida os parâmetros que declaram um schema Zod e
 * devolve os erros como Problem Details, um item por campo.
 */
export const createValidationPipe = () =>
  new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      Problems.validation(
        issues.map((issue) => ({
          field: fieldOf(issue),
          message: issue.message,
        })),
      ),
  });
