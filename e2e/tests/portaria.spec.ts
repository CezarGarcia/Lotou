import { expect, test } from '../support/fixtures';

/*
 * A portaria no celular. A câmera não é liberada no navegador de teste, então
 * a leitura usa o campo manual: é o que a equipe faz quando a câmera não lê.
 */
test('portaria libera a primeira entrada, barra a segunda e recusa um código adulterado', async ({
  page,
  comoComprador,
}) => {
  // Um ingresso novo do show de hoje, comprado pela API pelo comprador.
  const { show, pista } = await comoComprador.showDeHoje();
  const pedido = await comoComprador.comprarPista(show.id, pista);
  const codigo = pedido.tickets[0].code;
  const portao = `Portão E2E ${Math.floor(Math.random() * 1_000)}`;

  await page.goto('/portaria');
  await expect(page.getByRole('heading', { name: 'Onde você está?' })).toBeVisible();
  await page
    .getByRole('radiogroup', { name: 'Show' })
    .getByRole('radio', { name: new RegExp(show.title) })
    .check();
  await page.getByLabel('Portão').fill(portao);
  await page.getByRole('button', { name: 'Começar a leitura' }).click();
  await page.waitForURL(new RegExp(`/portaria/shows/${show.id}`));
  await expect(page.getByText(portao)).toBeVisible();

  const campo = page.getByLabel('Código do ingresso');
  // A tela cheia do resultado: verde (ok), amarelo (warn) ou vermelho (error) no `data-tone`.
  const resultado = page.locator('.result');
  const historico = page.getByRole('region', { name: 'Últimas leituras' }).getByRole('listitem');

  /** Digita o código, valida com Enter e devolve o resultado que a API respondeu. */
  const ler = async (texto: string): Promise<string> => {
    await campo.fill(texto);
    const resposta = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/checkins') && response.request().method() === 'POST',
    );
    await campo.press('Enter');
    return ((await (await resposta).json()) as { result: string }).result;
  };

  // Verde. A portaria recebe o ingresso pelo Kafka (TicketsIssued): logo depois da compra,
  // a cópia local pode ainda não ter chegado, e o leitor diz "não encontrado" até chegar.
  let primeira = await ler(codigo);
  for (let tentativa = 0; primeira === 'UNKNOWN_TICKET' && tentativa < 30; tentativa++) {
    await page.waitForTimeout(1_000);
    primeira = await ler(codigo);
  }
  expect(primeira).toBe('ACCEPTED');
  await expect(resultado).toHaveAttribute('data-tone', 'ok');
  await expect(resultado).toContainText('Entrada liberada');
  await expect(resultado).toContainText('Pista');

  // Amarelo: o mesmo ingresso de novo, com o portão da primeira entrada.
  expect(await ler(codigo)).toBe('ALREADY_USED');
  await expect(resultado).toHaveAttribute('data-tone', 'warn');
  await expect(resultado).toContainText('Ingresso já utilizado');
  await expect(resultado).toContainText(`pelo ${portao}`);

  // Vermelho: um caractere da assinatura trocado (no meio dela, onde todos os bits contam).
  const posicao = codigo.length - 5;
  const trocado = codigo[posicao] === 'A' ? 'B' : 'A';
  const adulterado = `${codigo.slice(0, posicao)}${trocado}${codigo.slice(posicao + 1)}`;
  expect(await ler(adulterado)).toBe('INVALID_CODE');
  await expect(resultado).toHaveAttribute('data-tone', 'error');
  await expect(resultado).toContainText('QR code inválido');

  // A pessoa toca em "Próxima leitura"; o histórico guarda as leituras, a mais recente primeiro.
  await resultado.getByRole('button', { name: 'Próxima leitura' }).click();
  await expect(resultado).toBeHidden();
  await expect(historico.nth(0)).toHaveAttribute('data-tone', 'error');
  await expect(historico.nth(1)).toHaveAttribute('data-tone', 'warn');
  await expect(historico.nth(2)).toHaveAttribute('data-tone', 'ok');
});
