import { codigoDeCupom, brl, brlRegex } from '../support/dados';
import { expect, test } from '../support/fixtures';
import { abrirCheckout, pagar, qrDosIngressos, reservar } from '../support/loja';

const SHOW = 'Baile da Maré Cheia';
const DESCONTO_PERCENT = 20;

test('compradora compra pista com cupom e vê o pedido confirmado com o QR', async ({
  page,
  visitante,
  comoComprador,
  comoProdutor,
}) => {
  const show = await visitante.showDoSeed(SHOW);
  // O produtor cria um cupom só desta execução.
  const cupom = await comoProdutor.criarCupom(
    show.id,
    codigoDeCupom('E2E-PISTA'),
    DESCONTO_PERCENT,
  );

  await abrirCheckout(page, show.id, 'Pista');
  const reservaId = await reservar(page);

  // Os valores esperados saem das regras: o preço é o do lote congelado na reserva.
  const { totalCents: subtotal } = await comoComprador.reserva(reservaId);
  const desconto = Math.floor((subtotal * DESCONTO_PERCENT) / 100);
  const taxa = show.serviceFeePaidBy === 'BUYER' ? Math.round(subtotal / 10) : 0;
  const total = subtotal - desconto + taxa;

  const pagamento = page.getByRole('complementary', { name: 'Pagamento' });
  await expect(
    pagamento.getByRole('button', { name: `Pagar ${brl(subtotal + taxa)}` }),
  ).toBeVisible();

  await pagamento.getByRole('button', { name: 'Tenho um cupom' }).click();
  await pagamento.getByLabel('Código do cupom').fill(cupom.toLowerCase());
  await pagamento.getByRole('button', { name: 'Aplicar' }).click();

  await expect(pagamento.getByText(`Cupom ${cupom} aplicado`, { exact: true })).toBeVisible();
  const linha = (texto: string) => pagamento.locator('dl > div').filter({ hasText: texto });
  await expect(linha('Desconto')).toContainText(cupom);
  await expect(linha('Desconto')).toContainText(new RegExp(`− ${brlRegex(desconto)}`));
  if (taxa > 0) {
    await expect(linha('Taxa de serviço')).toContainText(brl(taxa));
  } else {
    await expect(pagamento.getByText('Sem taxa de serviço')).toBeVisible();
  }
  await expect(linha('Total')).toContainText(brl(total));

  const pedidoId = await pagar(page);
  await expect(qrDosIngressos(page)).toHaveCount(1);
  await expect(page.getByText(`Desconto (cupom ${cupom})`)).toBeVisible();

  // O pedido gravado tem os mesmos valores da tela.
  const pedido = await comoComprador.pedido(pedidoId);
  expect(pedido).toMatchObject({
    status: 'CONFIRMED',
    subtotalCents: subtotal,
    discountCents: desconto,
    totalCents: total,
  });
});
