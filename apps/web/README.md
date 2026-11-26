# web

Frontend do Lotou. Angular 22 com standalone components, signals, o novo control flow (`@if`, `@for`) e sem zone.js.

Um único app com áreas carregadas sob demanda. Hoje existe a **loja**: busca de shows e página do show. O painel do produtor e a portaria entram como rotas irmãs nas próximas fases.

## Telas

| Rota | Tela | O que faz |
| --- | --- | --- |
| `/` | Busca de shows | filtra por artista, cidade e período; os filtros ficam na URL, e a lista pagina por cursor |
| `/shows/:id` | Página do show | data no fuso do local, setores, lotes, preços e contagem regressiva para a abertura das vendas |

## Como está organizado

```
src/app/
├── app.ts, app.config.ts, app.routes.ts   # moldura e rotas com lazy loading
├── core/
│   ├── telemetry/   # OpenTelemetry no navegador
│   ├── http/        # erros da API (Problem Details)
│   └── format/      # dinheiro (centavos -> R$) e datas no fuso do show
└── store/           # a loja
    ├── data/        # contrato e cliente da API de shows
    ├── search/      # busca: página, card e estado (signals + RxJS)
    ├── show/        # página do show e contagem regressiva
    └── shared/      # capa do show
```

Algumas decisões:

- **Estado em signals, fluxo em RxJS.** O estado da busca é um conjunto de signals; a mudança de filtros é um fluxo com `switchMap`, então uma resposta atrasada nunca sobrescreve uma busca mais nova. A página do show usa `httpResource`.
- **A URL é a fonte da verdade da busca.** O formulário só navega (`/?city=Recife`), e a busca reage aos parâmetros. O link de uma busca pode ser compartilhado e o botão voltar funciona.
- **Dinheiro em centavos.** A API manda inteiros; a divisão por 100 só acontece no pipe `brl`, na hora de exibir.
- **Datas no fuso do show.** A API manda UTC e o fuso IANA do local; o pipe `showDate` formata nesse fuso, não no do navegador.
- **Mesmo domínio para tudo.** O nginx (ou o proxy do `ng serve`) encaminha `/api` ao gateway e `/otlp` ao OTel Collector. Sem CORS.

## Observabilidade

[`core/telemetry/telemetry.ts`](src/app/core/telemetry/telemetry.ts) liga o OpenTelemetry antes do bootstrap: carregamento da página, `fetch` e XHR viram spans, e cada chamada à API leva o cabeçalho `traceparent`. É no navegador que nasce o trace que atravessa o gateway e o event-service até o MongoDB.

## Comandos

```bash
npm ci
npm start        # http://localhost:4200, com proxy para o gateway (8080) e o Collector (4318)
npm test         # testes unitários (Vitest)
npm run build    # build de produção em dist/web/browser
```

Para o `npm start` funcionar, suba o backend antes: `make up` na raiz do repositório.
