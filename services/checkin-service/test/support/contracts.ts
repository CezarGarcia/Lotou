import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { readFileSync } from 'node:fs';

/**
 * Os contratos da raiz do repositório (`contracts/`), lidos direto da pasta:
 * os testes do produtor validam o que ele publica contra o schema, e os do
 * consumidor leem os exemplos (ADR 28).
 */
const CONTRACTS = new URL('../../../../contracts/', import.meta.url);

// O pacote é CommonJS; conforme o carregador, a função vem em `default`.
const addFormats = ((addFormatsModule as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => Ajv2020;

const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));
const validators = new Map<string, ValidateFunction>();

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, CONTRACTS), 'utf8'));

function validator(topic: string, type: string, version: number) {
  const path = `${topic}/${type}.v${version}.schema.json`;
  let validate = validators.get(path);
  if (!validate) {
    validate = ajv.compile(readJson(path) as object);
    validators.set(path, validate);
  }
  return validate;
}

/** Os erros de validação da mensagem contra o schema do tipo dela; vazio se passa. */
export function contractErrors(topic: string, message: unknown): string[] {
  const { type, version } = message as { type: string; version: number };
  const validate = validator(topic, type, version);
  return validate(message)
    ? []
    : (validate.errors ?? []).map(
        (error) => `${error.instancePath || '/'} ${error.message ?? ''}`,
      );
}

/** O exemplo de `contracts/examples/`, como objeto. */
export function contractExample<T = Record<string, any>>(
  topic: string,
  type: string,
  version = 1,
): T {
  return readJson(`examples/${topic}/${type}.v${version}.json`) as T;
}
