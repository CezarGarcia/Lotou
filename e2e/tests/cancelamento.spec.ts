import { expect, test } from '../support/fixtures';
import { abrirCheckout, pagar, qrDosIngressos, reservar } from '../support/loja';

// Um show a mais de 48 horas: o pedido ainda pode ser cancelado.
const SHOW = 'Baile da Maré Cheia';

test('compradora cancela o pedido e recebe o reembolso', async ({ page, visitante }) => {
  const show = await visitante.showDoSeed(SHOW);
  await abrirCheckout(page, show.id, 'Pista');
  await reservar(page);
  await pagar(page);
  await expect(qrDosIngressos(page)).toHaveCount(1);

  const cancelamento = page.getByRole('region', { name: 'Cancelamento' });
  await expect(cancelamento).toContainText('Você pode cancelar este pedido');
  await cancelamento.getByRole('button', { name: 'Cancelar pedido' }).click();

  const dialogo = page.getByRole('dialog', { name: 'Cancelar o pedido?' });
  await expect(dialogo).toContainText('Reembolso integral');
  await dialogo.getByRole('button', { name: 'Cancelar e pedir reembolso' }).click();
  await expect(dialogo).toBeHidden();

  // A saga de reembolso estorna o pagamento pelo Kafka; a tela acompanha o pedido.
  await expect(page.getByRole('heading', { name: 'Pedido reembolsado' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('Ingresso cancelado')).toBeVisible();
  await expect(qrDosIngressos(page)).toHaveCount(0);
});
