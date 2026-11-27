import { expect, test as setup } from '@playwright/test';
import { USUARIOS, sessaoDe, type Papel } from '../support/ambiente';

/*
 * Login de cada usuário de demonstração pela tela do Keycloak, uma vez por
 * execução. O que fica gravado é o cookie da sessão do Keycloak: a loja guarda
 * os tokens no sessionStorage (que o storageState não leva), então a primeira
 * tela protegida de cada teste passa pelo Keycloak e volta sem pedir a senha.
 */
for (const papel of Object.keys(USUARIOS) as Papel[]) {
  setup(`login: ${papel}`, async ({ page }) => {
    const { username, password, nome } = USUARIOS[papel];
    await page.goto('/');
    await page.getByRole('button', { name: 'Entrar' }).click();

    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#kc-login').click();

    // De volta à loja, com o menu da conta (e o nome) no cabeçalho.
    await expect(page.getByRole('button', { name: `Conta de ${nome}` })).toBeVisible();
    await page.context().storageState({ path: sessaoDe(papel) });
  });
}
