import { expect, test } from '../support/fixtures';
import { abrirCheckout, pagar, qrDosIngressos, reservar } from '../support/loja';

// O ingresso abre sem internet (ADR 37): o service worker guarda a loja no
// aparelho, e a carteira guarda os ingressos dos próximos shows.
const SHOW = 'Baile da Maré Cheia';

test('o ingresso comprado abre sem internet, com o QR', async ({ page, context, visitante }) => {
  const show = await visitante.showDoSeed(SHOW);
  await abrirCheckout(page, show.id, 'Pista');
  await reservar(page);
  await pagar(page);
  await expect(qrDosIngressos(page)).toHaveCount(1);

  // O service worker termina de guardar a loja (o registro sai em até 5 s).
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state;
  });

  await context.setOffline(true);
  // Sem internet, "Meus ingressos" (que pede login) leva aos ingressos salvos.
  await page.goto('/meus-ingressos');
  await expect(page).toHaveURL(/\/ingressos-salvos$/);
  await expect(page.getByRole('status').filter({ hasText: 'Sem internet' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: show.artist })).toBeVisible();
  await expect(qrDosIngressos(page).first()).toBeVisible();

  await context.setOffline(false);
});
