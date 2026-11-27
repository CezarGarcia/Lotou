import { test as base } from '@playwright/test';
import { Gateway } from './api';

/**
 * O `test` da suíte: além da página, a API pelo gateway em nome de cada
 * usuário de demonstração. As fixtures são preguiçosas: o token só é pedido
 * ao Keycloak quando o teste usa o papel.
 */
export const test = base.extend<{
  visitante: Gateway;
  comoComprador: Gateway;
  comoProdutor: Gateway;
}>({
  visitante: async ({ request }, use) => {
    await use(new Gateway(request));
  },
  comoComprador: async ({ request }, use) => {
    await use(await Gateway.como(request, 'comprador'));
  },
  comoProdutor: async ({ request }, use) => {
    await use(await Gateway.como(request, 'produtor'));
  },
});

export { expect } from '@playwright/test';
