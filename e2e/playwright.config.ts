import { defineConfig, devices } from '@playwright/test';
import { USER_AGENT, WEB_URL, sessaoDe } from './support/ambiente';

/**
 * Testes ponta a ponta do Lotou, contra o ambiente do Compose no ar
 * (`make up` e `make seed`). Nada aqui sobe serviço: a suíte usa a loja, o
 * Keycloak e o gateway de verdade, como uma pessoa usaria.
 *
 * Um projeto por papel, cada um com a sessão gravada pelo `setup`.
 */
const CI = !!process.env.CI;

// Navegador fora do lugar padrão do Playwright (um Chromium já instalado na máquina).
// No CI fica vazio: o Chromium vem do `npx playwright install --with-deps chromium`.
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;

// User-Agent que começa com "lotou-e2e": o Collector guarda sempre esses traces (USER_AGENT).
// O resto do texto é o do aparelho emulado, para a loja seguir vendo um celular na portaria.
const userAgent = (aparelho?: string) => (aparelho ? `${USER_AGENT} ${aparelho}` : USER_AGENT);
const aparelho = (nome: string) => ({
  ...devices[nome],
  userAgent: userAgent(devices[nome].userAgent),
});

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : 3,
  // A saga confirma o pedido pelo Kafka e o reembolso leva alguns segundos.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_URL,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    // Trace e screenshot só de teste que falhou.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    userAgent: userAgent(),
    launchOptions: { executablePath },
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'comprador',
      testMatch: /(compra|cancelamento|ingresso).*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...aparelho('Desktop Chrome'), storageState: sessaoDe('comprador') },
    },
    {
      name: 'produtor',
      testMatch: /produtor.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...aparelho('Desktop Chrome'), storageState: sessaoDe('produtor') },
    },
    {
      // A portaria trabalha no celular.
      name: 'portaria',
      testMatch: /portaria.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...aparelho('Pixel 7'), storageState: sessaoDe('portaria') },
    },
  ],
});
