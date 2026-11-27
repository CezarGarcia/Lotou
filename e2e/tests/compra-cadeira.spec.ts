import { expect, test } from '../support/fixtures';
import { abrirCheckout, pagar, qrDosIngressos, reservar } from '../support/loja';

const SHOW = 'Vinte Anos de Estrada';
const SETOR = 'Plateia';

test('compradora escolhe uma cadeira livre no mapa e compra', async ({ page, visitante }) => {
  const show = await visitante.showDoSeed(SHOW);
  await abrirCheckout(page, show.id, SETOR);

  const mapa = page.getByRole('grid', { name: `Cadeiras do setor ${SETOR}` });
  await expect(mapa).toHaveAttribute('aria-busy', 'false');

  // Uma cadeira livre qualquer: sortear evita disputar a mesma com outra execução.
  const livres = mapa.getByRole('gridcell', { name: /, livre$/ });
  const quantas = await livres.count();
  expect(quantas).toBeGreaterThan(0);
  const cadeira = livres.nth(Math.floor(Math.random() * quantas));
  const rotulo = (await cadeira.getAttribute('data-seat'))!;
  await cadeira.click();

  const escolhida = mapa.getByRole('gridcell', { selected: true });
  await expect(escolhida).toHaveCount(1);
  await expect(escolhida).toHaveAttribute('data-seat', rotulo);
  const resumo = page.getByRole('complementary', { name: 'Resumo da compra' });
  await expect(resumo.locator('dl > div').filter({ hasText: 'Cadeiras' })).toContainText(rotulo);

  await reservar(page);
  const reserva = page.getByRole('region', { name: SETOR });
  await expect(reserva).toContainText(`Cadeira ${rotulo}`);

  await pagar(page);
  await expect(qrDosIngressos(page)).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Ingressos' })).toContainText(`Cadeira ${rotulo}`);
});
