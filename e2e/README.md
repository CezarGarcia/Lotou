# e2e

Testes ponta a ponta do Lotou com Playwright. Um Chromium faz o que as pessoas fazem na loja Angular, contra o ambiente do Compose no ar: o login é na tela do Keycloak, e as compras passam pelo gateway, pela saga no Kafka e pelo pagamento simulado, sem nenhum dublê.

## Como rodar

Com o ambiente no ar e o seed do dia (o show de hoje é o que a portaria lê):

```bash
make up seed
make e2e
```

Na primeira vez, instale o navegador: `cd e2e && npx playwright install chromium`. Para usar um Chromium que já está na máquina, aponte `CHROMIUM_EXECUTABLE_PATH` para ele. `WEB_URL`, `GATEWAY_URL` e `KEYCLOAK_URL` trocam os endereços (os padrões são os do Compose).

Em `e2e/`: `npx playwright test --ui` abre o modo interativo, `npm run report` abre o último relatório, `npm run typecheck` confere os tipos e `npm run format:check` a formatação.

## Cenários

| Teste                | Papel                | O que faz                                                                                                                                                                                   |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compra-pista-cupom` | comprador            | o produtor cria um cupom pela API; a compradora reserva pista no "Baile da Maré Cheia", aplica o cupom no pagamento, confere desconto, taxa e total, paga e vê o pedido confirmado com o QR |
| `compra-cadeira`     | comprador            | escolhe uma cadeira livre no mapa em SVG de "Vinte Anos de Estrada" e compra até o pedido confirmado                                                                                        |
| `cancelamento`       | comprador            | compra e cancela pelo diálogo ("Cancelar e pedir reembolso"), até "Pedido reembolsado"                                                                                                      |
| `produtor`           | produtor             | cria um cupom na aba Cupons e confere o relatório na aba Financeiro                                                                                                                         |
| `portaria`           | portaria, no celular | compra um ingresso do show de hoje pela API, escolhe show e portão e digita o código: verde, depois amarelo com o portão da primeira entrada; um código adulterado dá vermelho              |

## Como funciona

- **Login uma vez por papel.** O projeto `setup` entra com `comprador`, `produtor` e `portaria` (senha `lotou123`) pela tela do Keycloak e grava a sessão em `.auth/`. A loja guarda os tokens no `sessionStorage`, que o `storageState` não leva: o que fica gravado é o cookie da sessão do Keycloak. A primeira tela protegida de cada teste passa pelo Keycloak e volta sem pedir a senha.
- **Dados pela API quando não são o assunto do teste.** O cupom do cenário de compra e o ingresso da portaria são criados pelo gateway, em nome dos usuários de demonstração (fluxo de senha no cliente `lotou-seed`, o mesmo do `make seed`).
- **Repetível no mesmo ambiente.** Cada reserva usa um CPF válido novo (o limite de 4 por CPF nunca barra), cada cupom tem um código único por execução, a cadeira é sorteada entre as livres e nenhum teste depende do que outro deixou. Rodar duas vezes seguidas passa.
- **Os valores vêm das regras.** O desconto, a taxa de 10% e o total esperados são calculados a partir do preço congelado na reserva, não copiados da tela.
- **Falhas investigáveis.** Trace e screenshot só de teste que falhou, no relatório HTML (`playwright-report/`), que o CI sobe como artifact. Tudo sai com User-Agent começando por `lotou-e2e`, e o Collector guarda sempre esses traces: o trace da falha está no Tempo.

No CI, o workflow `smoke` roda a suíte depois do `make smoke`, com um retry.
