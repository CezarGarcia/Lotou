import { codigoDeCupom } from '../support/dados';
import { expect, test } from '../support/fixtures';

const SHOW = 'Baile da Maré Cheia';

test('produtor cria um cupom e confere o relatório financeiro', async ({ page, visitante }) => {
  const show = await visitante.showDoSeed(SHOW);
  const codigo = codigoDeCupom('E2E-PAINEL');

  // O painel exige o papel de produtor: passa pelo Keycloak e volta à lista de shows.
  await page.goto('/painel');
  await expect(page.getByRole('heading', { level: 1, name: 'Meus shows' })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(show.title) }).click();
  await expect(page.getByRole('heading', { level: 1, name: show.artist })).toBeVisible();

  const abas = page.getByRole('tablist', { name: 'Telas do show' });
  await abas.getByRole('tab', { name: 'Cupons' }).click();
  await expect(abas.getByRole('tab', { name: 'Cupons' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Novo cupom' }).click();

  const formulario = page.getByRole('form', { name: 'Novo cupom' });
  await formulario.getByLabel('Código').fill(codigo.toLowerCase());
  await expect(formulario.getByLabel('Código')).toHaveValue(codigo);
  await formulario.getByRole('radio', { name: 'Percentual sobre os ingressos' }).check();
  await formulario.getByRole('spinbutton', { name: /^Desconto/ }).fill('15');
  await formulario.getByRole('spinbutton', { name: /^Limite de usos/ }).fill('50');
  // A validade vem preenchida com o início do show.
  await expect(formulario.getByLabel('Válido até')).not.toHaveValue('');
  await formulario.getByRole('button', { name: 'Criar cupom' }).click();

  await expect(page.getByText(`Cupom ${codigo} criado.`)).toBeVisible();
  const cartao = page.getByRole('listitem').filter({ hasText: codigo });
  await expect(cartao).toContainText('Ativo');
  await expect(cartao).toContainText('15% de desconto nos ingressos');
  await expect(cartao.getByRole('meter', { name: `Usos do cupom ${codigo}` })).toHaveAttribute(
    'aria-valuemax',
    '50',
  );

  await abas.getByRole('tab', { name: 'Financeiro' }).click();
  const relatorio = page.getByRole('region', { name: /Relatório financeiro/ });
  for (const linha of [
    'Vendas brutas',
    'Descontos de cupom',
    'Reembolsos',
    'Taxa de serviço absorvida',
    'Valor a receber',
  ]) {
    // O rótulo abre o termo (as linhas que subtraem começam com o sinal de menos).
    const termo = relatorio.getByRole('term').filter({ hasText: new RegExp(`^−?${linha}`) });
    await expect(termo).toBeVisible();
  }
  await expect(relatorio).toContainText('Parcial');
  await expect(relatorio.getByRole('button', { name: 'Receber PDF por e-mail' })).toBeEnabled();
});
