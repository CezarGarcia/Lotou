// Fotografa os diagramas de docs/tecnologias/diagramas/*.html e grava os PNGs
// em docs/tecnologias/img/. Cada página tem um `.canvas`; a foto é dele.
//
// Uso, na raiz: node scripts/diagramas/render.mjs [nome ...]
// Sem nomes, refaz todos. Usa o Playwright instalado em e2e/ (cd e2e && npm ci;
// na primeira vez, npx playwright install chromium).
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'e2e/package.json'));
const { chromium } = require('@playwright/test');

const source = path.join(root, 'docs/tecnologias/diagramas');
const target = path.join(root, 'docs/tecnologias/img');
const wanted = process.argv.slice(2);
const pages = readdirSync(source)
  .filter((file) => file.endsWith('.html') && !file.startsWith('_'))
  .filter((file) => wanted.length === 0 || wanted.includes(path.basename(file, '.html')));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
});
// Duas vezes a resolução: a imagem fica nítida em telas de alta densidade.
const page = await browser.newPage({ viewport: { width: 1300, height: 900 }, deviceScaleFactor: 2 });
let failed = false;
page.on('console', (message) => {
  if (message.type() === 'error') {
    failed = true;
    console.error(`  erro no console: ${message.text()}`);
  }
});
for (const file of pages) {
  const name = path.basename(file, '.html');
  await page.goto(pathToFileURL(path.join(source, file)).href);
  await page.waitForFunction(() => window.__diagramaPronto === true, null, { timeout: 10_000 });
  await page.locator('.canvas').screenshot({ path: path.join(target, `${name}.png`) });
  console.log(`docs/tecnologias/img/${name}.png`);
}
await browser.close();
process.exit(failed ? 1 : 0);
