# web

Frontend do Lotou. Angular 22 com standalone components, signals, o novo control flow (`@if`, `@for`) e sem zone.js.

Um único app com áreas carregadas sob demanda: a **loja** (busca, página do show e a compra inteira, do login ao ingresso com QR code) e o **painel do produtor** (`/painel`, com as vendas de cada show ao vivo por WebSocket). A portaria entra como rota irmã numa próxima fase.

## Telas

| Rota | Tela | O que faz | Login |
| --- | --- | --- | --- |
| `/` | Busca de shows | filtra por artista, cidade e período; os filtros ficam na URL, e a lista pagina por cursor | — |
| `/shows/:id` | Página do show | data no fuso do local, setores com lote, preço e estoque ao vivo (consulta a cada 5 s), contagem regressiva para a abertura e a escolha do setor | — |
| `/shows/:id/fila?setor=` | Fila virtual | só em show de alta demanda: entra na fila, mostra posição e espera estimada por SSE, explica o sorteio da sala de espera e leva ao checkout quando chega a vez | sim |
| `/shows/:id/comprar/:sectorId` | Checkout | pista: quantidade de 1 a 4; lugar marcado: mapa de cadeiras em SVG ao vivo; CPF com máscara e dígitos verificadores; reserva | sim |
| `/reservas/:id` | Reserva | resumo, cronômetro de 10 minutos e o pagamento (simulado); quando o tempo acaba, a reserva aparece expirada | sim |
| `/pedidos/:id` | Pedido | ingressos do pedido confirmado, cada um com o QR code da entrada, o motivo de um cancelamento ou a espera enquanto o pagamento é processado | sim |
| `/meus-ingressos` | Meus ingressos | pedidos do comprador, do mais novo ao mais antigo, com "carregar mais" | sim |
| `/painel` | Meus shows (produtor) | shows do produtor com data no fuso do local, situação, ingressos vendidos e receita, paginados por cursor | produtor |
| `/painel/shows/:id` | Painel ao vivo (produtor) | números gerais, vendas por setor e feed de atividade, atualizados pelo WebSocket do analytics | produtor |

O preço que o comprador paga vem sempre da disponibilidade (o lote em venda agora, no inventory), nunca do documento do show: é esse preço que a reserva congela.

## Como está organizado

```
src/app/
├── app.ts, app.config.ts, app.routes.ts   # moldura, login no cabeçalho e rotas com lazy loading
├── core/
│   ├── auth/        # login OIDC: configuração, serviço, interceptor e guard
│   ├── telemetry/   # OpenTelemetry no navegador
│   ├── http/        # Problem Details, leitor de SSE e chave de idempotência
│   ├── forms/       # CPF: validação e máscara
│   └── format/      # dinheiro (centavos -> R$), contagens e datas no fuso do show
├── producer/        # o painel do produtor
│   ├── data/        # cliente da lista de shows do analytics
│   ├── shows/       # "Meus shows"
│   ├── live/        # painel ao vivo: protocolo, cliente WebSocket, estado, setores e feed
│   └── producer.guard.ts, producer.routes.ts
└── store/           # a loja
    ├── data/        # contratos e clientes da API (shows, disponibilidade, fila, reservas, pedidos)
    ├── search/      # busca: página, card e estado (signals + RxJS)
    ├── show/        # página do show e painel de compra
    ├── queue/       # fila virtual
    ├── checkout/    # checkout e mapa de cadeiras
    ├── reservation/ # reserva e pagamento
    ├── orders/      # pedido e "Meus ingressos"
    └── shared/      # capa, cabeçalho das telas de compra, contagem regressiva, disponibilidade ao vivo e mensagens de erro
```

Algumas decisões:

- **Estado em signals, fluxo em RxJS.** O estado das telas é um conjunto de signals; o que é fluxo (busca com `switchMap`, consulta periódica, SSE, fila) é RxJS, e chega à tela como signal. Uma resposta atrasada nunca sobrescreve uma mais nova.
- **A URL é a fonte da verdade da busca.** O formulário só navega (`/?city=Recife`), e a busca reage aos parâmetros. O link de uma busca pode ser compartilhado e o botão voltar funciona.
- **Dinheiro em centavos.** A API manda inteiros; a divisão por 100 só acontece no pipe `brl`, na hora de exibir.
- **Datas no fuso do show.** A API manda UTC e o fuso IANA do local; o pipe `showDate` formata nesse fuso, não no do navegador.
- **Mesmo domínio para tudo.** O nginx (ou o proxy do `ng serve`) encaminha `/api` ao gateway e `/otlp` ao OTel Collector. Sem CORS.
- **Idempotência por tentativa.** Cada `POST /reservations` leva uma `Idempotency-Key` (UUID v7). Repetir o mesmo pedido depois de uma falha passageira (rede, 503, 429) reaproveita a chave, então um clique duplo ou um retry nunca reserva duas vezes; mudar o pedido ou receber uma recusa definitiva começa uma tentativa nova. O pedido de uma reserva usa uma chave só.

## Login

Login com o Keycloak por OpenID Connect, no fluxo Authorization Code com PKCE (ADR 19), usando a biblioteca `angular-auth-oidc-client`. O cliente `lotou-web` é público: não há segredo no navegador.

- Endereços em um lugar só: [`core/auth/auth.config.ts`](src/app/core/auth/auth.config.ts) (realm, cliente, redirect e escopos `openid profile email`).
- Antes da primeira rota, o `AuthService` lê a sessão guardada ou, na volta do Keycloak, troca o código pelos tokens. Se o Keycloak estiver fora do ar, a loja abre sem login.
- O access token dura 5 minutos e é renovado com o refresh token 30 s antes de vencer (sem iframe).
- O cabeçalho mostra "Entrar" ou o primeiro nome, "Meus ingressos" e "Sair", e "Painel" só para quem tem o papel `producer`. Os papéis do realm (`buyer`, `producer`, `gate-staff`) vêm da claim `realm_access.roles` do access token; uma conta sem `buyer` vê o aviso na página do show.
- O interceptor funcional põe `Authorization: Bearer` só nas chamadas a `/api/` no mesmo domínio da loja: o token nunca vai para o Collector, para o Keycloak ou para outro site.
- O guard das telas de compra leva quem não entrou ao Keycloak e, na volta, abre a página que ele queria, com os parâmetros (`/shows/1/fila?setor=2`). Só caminhos internos servem de volta.
- Tokens, e-mail e CPF não vão para log nem para a telemetria. O span do carregamento da página tem o `code` e o `state` do login trocados por `REDACTED`, e os logs da biblioteca ficam desligados no build de produção.

## Tempo real: o leitor de SSE

A fila virtual exige o token do comprador, e o `EventSource` do navegador não envia cabeçalhos. Por isso o Lotou tem um leitor de Server-Sent Events próprio, em [`core/http/sse.ts`](src/app/core/http/sse.ts), pequeno e sem dependências:

- `readSse(url, opções)` devolve um Observable. A conexão é um `fetch` com `Accept: text/event-stream`, lido com `ReadableStream` e `TextDecoder`.
- O parser é incremental e segue a especificação do HTML: `event:`, `data:` em várias linhas, `id:` e `retry:`; comentários (`:`) são os heartbeats; uma linha pode chegar partida entre dois pedaços.
- Se a conexão cai ou o servidor encerra o fluxo, reconecta com espera exponencial (1 s, 2 s, 4 s... até 30 s), com variação aleatória para milhares de navegadores não voltarem juntos, e manda o `Last-Event-ID`. Um 429 ou 503 respeita o `Retry-After`. Um 4xx encerra o Observable com erro.
- Os cabeçalhos são montados a cada conexão: um token renovado entra na reconexão seguinte (o `SseClient` cuida disso). Cancelar a inscrição aborta a requisição.
- Nada de instrumentação extra: o `fetch` já é rastreado pelo OpenTelemetry.

Quem usa:

- **Fila virtual** (`/api/v1/queue/{show}/events`): evento `status` a cada segundo, até a admissão.
- **Mapa de cadeiras** (`/api/v1/availability/{show}/sectors/{setor}/seats/events`): primeiro a foto do setor (`snapshot`), depois as mudanças (`seats`). Cada cadeira tem o próprio signal, então uma mudança toca só os atributos das cadeiras citadas, sem redesenhar o mapa. Uma cadeira escolhida que outra pessoa pega sai da seleção, com aviso. Cada reconexão traz uma foto nova; se o servidor recusar o fluxo, o mapa passa a ser consultado a cada 10 s.

No Docker, o nginx encaminha os fluxos `/api/.../events` sem buffer e sem compressão, com a conexão aberta por até 1 hora.

## Painel do produtor

`/painel` é uma área à parte, carregada sob demanda: nada dela entra no pacote da loja. O guard (`producer.guard.ts`) leva quem não entrou ao Keycloak e quem entrou sem o papel `producer` à tela "Acesso restrito". O guard só decide o que a loja mostra; quem protege os dados é o servidor, que confere o papel no token.

- **Meus shows:** `GET /api/v1/analytics/shows`, paginado por cursor, com estado vazio e erro em Problem Details (com o `traceId` para o suporte).
- **Painel ao vivo:** ingressos vendidos e restantes, receita, pedidos confirmados, cancelados e no último minuto; por setor, vendidos sobre a capacidade, restantes e o lote em venda com preço e situação; e o feed de atividade (pedido confirmado ou cancelado, lote aberto ou esgotado), do mais novo ao mais antigo, até 50 entradas, com tempo relativo ("há 12 s") e a hora completa no fuso do show. O indicador mostra "Conectando...", "Ao vivo" ou "Reconectando..." (com "Tentar agora") e há quanto tempo chegaram os últimos dados.
- **Gráficos em CSS puro.** As barras dos setores são um `div` com largura em porcentagem e `role="meter"`. O documento do projeto cita o ngx-echarts; para barras de progresso, ele somaria centenas de kB sem ganho. Fica para telas com séries no tempo (financeiro).
- A fila e as entradas na portaria ainda não estão no protocolo; o painel não mostra nada sobre elas em vez de inventar números.
- **Acessibilidade:** os números são uma lista de definições (`dl`), cada barra tem o texto "1.180 de 2.000 vendidos (59%)" para leitores de tela, o feed rola e recebe foco pelo teclado, e as novidades são anunciadas numa região `aria-live="polite"` separada, no máximo uma vez a cada 10 s (com a contagem e a mais recente): numa abertura de vendas, ler cada pedido em voz alta tornaria o leitor de tela inutilizável.

### O cliente WebSocket

O protocolo está em [`contracts/realtime-dashboard.md`](../../contracts/realtime-dashboard.md); o cliente é o `LiveDashboardClient`, em [`producer/live/live-dashboard.client.ts`](src/app/producer/live/live-dashboard.client.ts). SSE na loja e WebSocket no painel é proposital (ADR 17): no painel o cliente também fala, assinando e cancelando shows na mesma conexão.

- **Uma conexão por aba**, aberta quando a tela assina um show (`watch(showId)` devolve um Observable) e fechada 10 s depois que a última tela sai: ir da lista ao show e voltar não reabre a conexão.
- **O token vai na primeira mensagem** (`auth`), nunca na URL (o navegador não deixa mandar cabeçalho num WebSocket). As assinaturas só saem depois do `ready`. Quando o `angular-auth-oidc-client` renova o token, o cliente manda `auth` de novo na mesma conexão; o `ready` que confirma a renovação não repete as assinaturas.
- **Reconexão com espera exponencial e jitter:** 1 s, 2 s, 4 s... até 30 s, cada espera sorteada entre a metade e o total, para milhares de painéis não voltarem juntos depois de um deploy do analytics. A contagem só volta a 1 s depois de 10 s de conexão estável, então um servidor que aceita e derruba logo não vira uma tempestade de conexões. Ao voltar, o cliente assina os mesmos shows e recebe uma foto nova. Sem rede, espera o navegador voltar a ficar on-line.
- **Conexão morta:** com show assinado, o servidor manda métricas a cada segundo; 15 s sem nenhuma mensagem e o cliente troca a conexão (o navegador não expõe o ping do protocolo).
- **Fechamentos:** 4401 (token recusado) renova a sessão uma vez e reconecta; na segunda recusa seguida, a tela oferece "Entrar de novo". 4403 (sem o papel) encerra sem tentar de novo. 4408, 1013 e quedas comuns reconectam com espera.
- **Frames inválidos são ignorados:** tudo o que chega é conferido (tipos, inteiros não negativos, datas); um frame que não é JSON, de tipo desconhecido ou com campo faltando não derruba a conexão, e uma entrada de tipo novo na foto é descartada sozinha.
- A aba escondida não pausa nada: é um painel ao vivo.
- O estado de cada show sai de uma função pura, `reduceDashboard` ([`dashboard.state.ts`](src/app/producer/live/dashboard.state.ts)): a foto substitui tudo, métricas mais velhas que as da tela são ignoradas, e a atividade entra na posição certa pelo ID do Redis Stream, sem repetir e com o limite de 50.
- Testes com um WebSocket falso ([`live.testing.ts`](src/app/producer/live/live.testing.ts)), que faz o papel do servidor.

No Docker, o nginx encaminha `/api/v1/analytics/live` com os cabeçalhos `Upgrade` e `Connection`, sem buffer e com leitura de até 1 hora; no `npm start`, o proxy tem `ws: true` para esse caminho.

## QR code do ingresso

O pedido traz `tickets[].code` (`LOTOU1.<ticketId>.<assinatura>`, assinado com HMAC pelo order-service, ADR 15), e a tela do pedido desenha um QR por ingresso. Ingressos emitidos antes do código assinado mostram "QR indisponível"; um ingresso cancelado não mostra QR.

- **Biblioteca `qrcode`** (node-qrcode): a mais usada para gerar QR em JavaScript, sem dependências no navegador, e implementa a norma inteira (modos, níveis de correção, máscaras). Escrever um gerador próprio seria código de risco sem relação com o projeto.
- **Carregada sob demanda:** é importada com `import()` dentro do componente, então vira um pacote próprio (cerca de 24 kB, 8 kB comprimido) baixado só quando um ingresso com código aparece. O pacote inicial não cresce.
- **SVG desenhado pelo Angular:** a biblioteca só calcula a matriz (`create`), e o componente monta um `path` SVG a partir dela, sem `innerHTML` nem desvio do sanitizador. Preto sobre branco mesmo no tema escuro, com zona de silêncio, nível de correção M e um rótulo para leitores de tela. No celular, o QR fica grande, em cima.
- A biblioteca é CommonJS, por isso `qrcode` e `dijkstrajs` estão em `allowedCommonJsDependencies` no `angular.json`.

## Mapa de cadeiras

Desenhado em SVG a partir das fileiras do local (`rows` de cada setor): uma fileira por linha, com o nome dos dois lados, cadeiras numeradas, o palco no alto e a legenda (livre, sua escolha, ocupada; a ocupada também tem um traço, para não depender só da cor). Até 4 cadeiras por compra.

- **Teclado:** o mapa é uma grade ARIA. Tab entra no mapa, as setas andam entre as cadeiras (para cima e para baixo, a mais próxima no desenho), Home e End vão ao começo e ao fim da fileira, Enter ou Espaço escolhe.
- **Zoom:** botões de aproximar e afastar, mantendo o centro. No celular, as cadeiras têm um tamanho mínimo e o mapa rola para o lado, começando de frente para o palco.

## Observabilidade

[`core/telemetry/telemetry.ts`](src/app/core/telemetry/telemetry.ts) liga o OpenTelemetry antes do bootstrap: carregamento da página, `fetch` e XHR viram spans, e cada chamada à API leva o cabeçalho `traceparent`. É no navegador que nasce o trace que atravessa o gateway e os serviços até o banco.

## Comandos

```bash
npm ci
npm start        # http://localhost:4200, com proxy para o gateway (8080) e o Collector (4318)
npm test         # testes unitários (Vitest)
npm run build    # build de produção em dist/web/browser
```

Para o `npm start` funcionar, suba o backend antes: `make up` na raiz do repositório. O login só funciona na porta 4200, a única cadastrada no cliente `lotou-web` do Keycloak. O painel exige uma conta com o papel `producer`: o usuário de teste `produtor` (senha `lotou123`), em nome de quem o `make seed` cria os shows.

O orçamento do pacote inicial é de 600 kB: a biblioteca de OIDC (cerca de 120 kB) precisa estar no pacote inicial, porque a sessão é resolvida antes da primeira rota. O Material fica nos pacotes de cada tela; o cabeçalho usa só HTML e CSS. O painel do produtor e a biblioteca de QR code ficam fora do pacote inicial.
