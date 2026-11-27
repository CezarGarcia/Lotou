import path from 'node:path';

/*
 * Onde o ambiente está no ar e quem entra nele. Os padrões são os do Compose
 * (`make up`); para apontar para outro lugar, use as variáveis de ambiente.
 */
export const WEB_URL = process.env.WEB_URL ?? 'http://localhost:4200';
export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:8080';
export const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8180';

/**
 * Cliente de desenvolvimento do realm com o fluxo de senha liberado (o mesmo
 * do `make seed`). Os testes o usam para preparar dados pela API em nome dos
 * usuários de demonstração; o navegador sempre entra pela tela do Keycloak.
 */
export const API_CLIENT_ID = process.env.E2E_CLIENT_ID ?? 'lotou-seed';
export const API_CLIENT_SECRET = process.env.E2E_CLIENT_SECRET ?? 'lotou-seed-dev-secret';

/**
 * O começo do User-Agent de tudo que a suíte manda (navegador e API). O
 * Collector guarda sempre os traces com esse prefixo, e amostra os outros: o
 * trace de um teste que falhou fica no Tempo.
 */
export const USER_AGENT = 'lotou-e2e Playwright';

/** Os usuários de demonstração do realm, um por papel. */
export const USUARIOS = {
  comprador: { username: 'comprador', password: 'lotou123', nome: 'Bia' },
  produtor: { username: 'produtor', password: 'lotou123', nome: 'Caio' },
  portaria: { username: 'portaria', password: 'lotou123', nome: 'Duda' },
} as const;

export type Papel = keyof typeof USUARIOS;

/** Onde o setup grava a sessão de cada papel (os cookies do Keycloak). */
export const sessaoDe = (papel: Papel) => path.resolve(__dirname, '..', '.auth', `${papel}.json`);
