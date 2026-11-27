import { Gateway } from '../support/api';
import { expect, test } from '../support/fixtures';

/*
 * A portaria sem internet (ADR 38). O leitor baixa o pacote offline do show
 * ao abrir; sem rede, confere o QR no aparelho com a chave pública, guarda a
 * entrada numa fila e a envia quando a rede volta.
 */
interface PacoteOffline {
  tickets: { id: string; status: string }[];
}

interface ResultadoOffline {
  results: { id: string; outcome: string }[];
}

interface Resumo {
  checkedIn: number;
  byGate: { gate: string; count: number }[];
}

test('sem internet, o leitor libera no aparelho, barra a segunda leitura e envia a entrada quando a rede volta', async ({
  page,
  context,
  request,
  comoComprador,
}) => {
  const { show, pista } = await comoComprador.showDeHoje();
  const pedido = await comoComprador.comprarPista(show.id, pista);
  const { id: ingresso, code: codigo } = pedido.tickets[0];
  const portao = `Portão Offline ${Math.floor(Math.random() * 1_000)}`;

  // A portaria recebe o ingresso pelo Kafka (TicketsIssued): o pacote só o
  // traz depois que a cópia local dele chegou.
  const comoPortaria = await Gateway.como(request, 'portaria');
  await expect
    .poll(
      async () =>
        (
          await comoPortaria.get<PacoteOffline>(`/checkins/shows/${show.id}/offline-package`)
        ).tickets.find((ticket) => ticket.id === ingresso)?.status,
      { timeout: 30_000 },
    )
    .toBe('VALID');

  // Abre o leitor com internet: ele baixa o pacote e guarda no aparelho.
  const pacote = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/checkins/shows/${show.id}/offline-package`),
  );
  await page.goto(`/portaria/shows/${show.id}?portao=${encodeURIComponent(portao)}`);
  expect((await pacote).ok()).toBe(true);

  const estado = page.getByRole('status').filter({ hasText: 'lista de' });
  await expect(estado).toContainText('Online');

  const campo = page.getByLabel('Código do ingresso');
  // A tela cheia do resultado: verde (ok), amarelo (warn) ou vermelho (error) no `data-tone`.
  const resultado = page.locator('.result');
  const ler = async (texto: string) => {
    await campo.fill(texto);
    await campo.press('Enter');
  };

  // Sem rede: o topo avisa, e a leitura é decidida no aparelho, sem chamar a API.
  await context.setOffline(true);
  await expect(estado).toContainText('Sem internet: validando neste aparelho');
  let chamouApi = false;
  page.on('request', (pedidoHttp) => {
    if (pedidoHttp.url().endsWith('/api/v1/checkins') && pedidoHttp.method() === 'POST') {
      chamouApi = true;
    }
  });

  await ler(codigo);
  await expect(resultado).toHaveAttribute('data-tone', 'ok');
  await expect(resultado).toContainText('Entrada liberada');
  await expect(resultado).toContainText('Pista');
  await expect(resultado.locator('.seal')).toHaveText(/Sem internet · validado neste aparelho/i);
  await expect(estado).toContainText('1 leitura para enviar');

  // A mesma pessoa de novo: amarelo, com o portão da entrada feita neste aparelho.
  await resultado.getByRole('button', { name: 'Próxima leitura' }).click();
  await ler(codigo);
  await expect(resultado).toHaveAttribute('data-tone', 'warn');
  await expect(resultado).toContainText('Ingresso já utilizado');
  await expect(resultado).toContainText(`pelo ${portao}`);
  expect(chamouApi).toBe(false);
  await resultado.getByRole('button', { name: 'Próxima leitura' }).click();

  // A rede volta: a fila vai para o servidor, que grava a entrada com o horário da leitura.
  const envio = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/checkins/offline') && response.request().method() === 'POST',
    { timeout: 45_000 },
  );
  await context.setOffline(false);
  const enviado = (await (await envio).json()) as ResultadoOffline;
  expect(enviado.results.map((resultadoEnvio) => resultadoEnvio.outcome)).toEqual(['RECORDED']);
  await expect(estado).toContainText('Online');
  await expect(estado).not.toContainText('para enviar');

  // O servidor conta a entrada pelo portão do aparelho.
  const resumo = await comoPortaria.get<Resumo>(`/checkins/shows/${show.id}/summary`);
  expect(resumo.byGate.find((item) => item.gate === portao)?.count).toBe(1);

  // Com internet, a leitura volta a ir ao servidor, que já sabe da entrada.
  const online = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/checkins') && response.request().method() === 'POST',
  );
  await ler(codigo);
  expect(((await (await online).json()) as { result: string }).result).toBe('ALREADY_USED');
  await expect(resultado).toHaveAttribute('data-tone', 'warn');
  await expect(resultado).toContainText(`pelo ${portao}`);
  await expect(resultado.locator('.seal')).toHaveCount(0);
});
