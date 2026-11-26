import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Os contratos dos eventos, em `contracts/` na raiz do repositório: o
 * produtor valida o que publica contra o schema, e o consumidor testa a
 * leitura com o exemplo (contracts/README.md).
 */
const CONTRACTS = fileURLToPath(
  new URL('../../../../contracts/', import.meta.url),
);

// ajv-formats é CommonJS: dependendo de quem importa, o plugin vem em `default`.
const addFormats = ((addFormatsModule as { default?: unknown }).default ??
  addFormatsModule) as (ajv: Ajv2020) => Ajv2020;

const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }));

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(`${CONTRACTS}${path}`, 'utf8'));

/** Valida uma mensagem contra `contracts/<tópico>/<Tipo>.v<versão>.schema.json`. */
export function contractErrors(
  topic: string,
  type: string,
  message: unknown,
  version = 1,
): string[] {
  const schema = readJson(`${topic}/${type}.v${version}.schema.json`) as {
    $id: string;
  };
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  return validate(message)
    ? []
    : (validate.errors ?? []).map(
        (error) => `${error.instancePath || '/'} ${error.message ?? ''}`,
      );
}

/** O exemplo válido de `contracts/examples/<tópico>/<Tipo>.v<versão>.json`. */
export function contractExample(
  topic: string,
  type: string,
  version = 1,
): Record<string, unknown> {
  return readJson(`examples/${topic}/${type}.v${version}.json`) as Record<
    string,
    unknown
  >;
}
