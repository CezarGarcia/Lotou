# web

Frontend do Lotou. Angular 22 com standalone components, signals, o novo control flow (`@if`, `@for`) e sem zone.js.

Um único app com três áreas carregadas sob demanda: a **loja** (busca, página do show e a compra inteira, do login ao ingresso com QR code, com cupom, taxa de serviço e cancelamento), o **painel do produtor** (`/painel`: vendas ao vivo por WebSocket, financeiro e cupons de cada show) e a **portaria** (`/portaria`: o leitor de QR no celular).

## Telas

| Rota | Tela | O que faz | Login |
| --- | --- | --- | --- |
| `/` | Busca de shows | filtra por artista, cidade e período; os filtros ficam na URL, e a lista pagina por cursor | — |
| `/shows/:id` | Página do show | data no fuso do local, setores com lote, preço e estoque ao vivo (consulta a cada 5 s), contagem regressiva para a abertura e a escolha do setor | — |
| `/shows/:id/fila?setor=` | Fila virtual | só em show de alta demanda: entra na fila, mostra posição e espera estimada por SSE, explica o sorteio da sala de espera e leva ao checkout quando chega a vez | sim |
| `/shows/:id/comprar/:sectorId` | Checkout | pista: quantidade de 1 a 4; lugar marcado: mapa de cadeiras em SVG ao vivo; CPF com máscara e dígitos verificadores; reserva | sim |
| `/reservas/:id` | Reserva | resumo, cronômetro de 10 minutos, o total (ingressos, desconto do cupom, taxa de serviço) e o pagamento (simulado); quando o tempo acaba, a reserva aparece expirada | sim |
| `/pedidos/:id` | Pedido | ingressos do pedido confirmado, cada um com o QR code, a entrada registrada ou o cancelamento; o cancelamento dentro da política, o reembolso enquanto anda e a espera enquanto o pagamento é processado | sim |
| `/meus-ingressos` | Meus ingressos | pedidos do comprador, do mais novo ao mais antigo, com "carregar mais" e a situação (inclusive reembolso) | sim |
| `/painel` | Meus shows (produtor) | shows do produtor com data no fuso do local, situação, ingressos vendidos e receita, paginados por cursor | produtor |
| `/painel/shows/:id` | Ao vivo (produtor) | números gerais, vendas por setor, entradas na portaria por portão, reembolsos e feed de atividade, pelo WebSocket do analytics; o cancelamento do show | produtor |
| `/painel/shows/:id/financeiro` | Financeiro (produtor) | relatório com cada linha e a fórmula explicadas, selo de parcial, PDF por e-mail e os reembolsos travados, com o reenvio | produtor |
| `/painel/shows/:id/cupons` | Cupons (produtor) | cupons com usos, restantes e desconto dado; criação, pausa e retomada | produtor |
| `/portaria` | Portaria | escolha do show (de hoje e dos próximos dias) e do portão, guardado no aparelho | portaria |
| `/portaria/shows/:id?portao=` | Leitor | câmera, código digitado ou leitor USB; resultado em tela cheia, contador de entradas e as últimas leituras | portaria |

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
├── shared/          # tela de acesso restrito, usada pelo painel e pela portaria
├── producer/        # o painel do produtor
│   ├── data/        # clientes do analytics, dos cupons e do financeiro
│   ├── shows/       # "Meus shows"
│   ├── show/        # moldura de um show: cabeçalho, abas e cancelamento do show
│   ├── live/        # painel ao vivo: protocolo, cliente WebSocket, estado, setores e feed
│   ├── finance/     # relatório financeiro e reembolsos travados
│   ├── coupons/     # cupons: lista, formulário e regras de validação
│   └── producer.guard.ts, producer.routes.ts
├── gate/            # a portaria
│   ├── data/        # cliente do checkin-service
│   ├── scanner/     # leitor: câmera, leitores de QR, resultado, repetições, vibração e bipe
│   └── gate-setup.page.ts, gate-settings.ts, gate.guard.ts, gate.routes.ts
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
- O cabeçalho mostra "Entrar" ou o primeiro nome, "Meus ingressos" e "Sair", "Painel" só para quem tem o papel `producer` e "Portaria" só para quem tem `gate-staff`. Num celular, com todos os papéis, o menu rola dentro dele. Os papéis do realm (`buyer`, `producer`, `gate-staff`) vêm da claim `realm_access.roles` do access token; uma conta sem `buyer` vê o aviso na página do show.
- O interceptor funcional põe `Authorization: Bearer` só nas chamadas a `/api/` no mesmo domínio da loja: o token nunca vai para o Collector, para o Keycloak ou para outro site.
- Os guards do painel e da portaria são o mesmo `roleGuard(papel, telaDeAcessoRestrito)` ([`core/auth/role.guard.ts`](src/app/core/auth/role.guard.ts)).
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
- Entradas na portaria (total, proporção dos vendidos e por portão) e pedidos reembolsados aparecem quando o analytics manda `checkedIn`, `checkinsByGate` e `ordersRefunded`; o feed ganha `TicketCheckedIn` e `OrderRefunded`. São opcionais: sem eles, o painel não mostra nada sobre isso em vez de inventar números. A fila ainda não está no protocolo.
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

## Cupom, taxa de serviço e total

O total vem sempre do servidor: a tela de pagamento pede o orçamento (`POST /orders/quote`) assim que a reserva carrega e mostra ingressos, desconto (com o código), taxa de serviço (só quando o show a repassa ao comprador; quando o produtor a absorve, uma linha discreta diz isso) e o total. A loja não recalcula nada, então nunca mostra um valor diferente do cobrado, e sem o orçamento o botão de pagar não aparece.

- **"Tenho um cupom"** abre o campo; o código vai sem espaços e em maiúsculas. Cada recusa (`coupon-invalid`) tem uma mensagem própria (não encontrado, vencido, pausado, esgotado, de outro show, de outro setor) junto do campo, anunciada aos leitores de tela. O cupom digitado por último vence uma resposta atrasada (`switchMap`), e o pagamento fica bloqueado enquanto um cupom é conferido.
- O pedido leva o cupom aceito. Se ele esgotar entre o orçamento e o pedido, o pedido é recusado com `coupon-invalid`: o cupom sai, o total volta sem desconto e o comprador decide se paga.
- A `Idempotency-Key` do pedido agora é por tentativa (`AttemptKey`): a mesma chave numa falha de rede, uma nova quando o corpo muda (outro cupom) ou depois de uma recusa definitiva.

## Cancelamento e reembolso

Quem decide se o pedido pode ser cancelado é o servidor (`cancellation.allowed`). A página do pedido só traduz: no prazo, mostra até quando (no fuso do show) e o botão; fora dele, o motivo (`WINDOW_EXPIRED`, `TOO_CLOSE_TO_SHOW`, `TICKET_USED`).

- O botão abre um diálogo com a política em palavras simples (pedido inteiro, reembolso integral com a taxa, 7 dias depois da compra e mais de 48 h antes do show). O foco começa em "Manter pedido": um Enter não cancela por engano.
- `REFUNDING` é consultado a cada 5 s (o estorno é mais lento que o pagamento), `REFUNDED` mostra o valor e a data, `REFUND_FAILED` avisa que a equipe vai entrar em contato. Se o show foi cancelado pelo produtor, a tela diz isso.
- Ingresso usado mostra a hora e o portão da entrada no lugar do QR; ingresso cancelado não tem QR.

## Portaria

`/portaria` é uma área à parte, carregada sob demanda e restrita ao papel `gate-staff`, como o painel. A pessoa escolhe o show (`GET /checkins/shows`) e o portão, que fica guardado no `localStorage` do aparelho; o leitor fica em `/portaria/shows/:id?portao=Portão B`, um link que pode ser recarregado.

- **Leitura do QR:** o `BarcodeDetector` do navegador quando ele existe e lê QR (Chrome no Android, Safari recente), sem custo de pacote. Nos outros (Firefox, Chrome no desktop Linux), o **`jsqr`**: a biblioteca de leitura de QR em JavaScript mais conhecida, sem dependências, licença Apache 2.0. É importada com `import()` só quando o navegador não tem o detector: vira um pacote próprio (cerca de 130 kB, 27 kB comprimido), fora do pacote inicial e da própria tela do leitor. O quadro do vídeo é reduzido a 640 px e lido 4 vezes por segundo, sem a tentativa de cor invertida (o QR do Lotou é preto no branco). `jsqr` é CommonJS, por isso está em `allowedCommonJsDependencies`. Um teste confere que o `jsqr` lê o QR que a página do pedido desenha.
- **Câmera traseira** (`facingMode: environment`), com o vídeo `muted` e `playsinline` para tocar sem gesto no iPhone. Sem permissão, sem câmera ou fora de HTTPS, a tela explica e o código digitado continua funcionando. A câmera é desligada ao sair da tela.
- **Código digitado ou leitor USB:** o campo aceita o texto do QR; um leitor USB "digita" o código e dá Enter. No computador o campo já começa com o foco; no celular não, para o teclado não cobrir a câmera.
- **Resultado em tela cheia:** verde (liberado, com setor e cadeira), amarelo (já utilizado, com a hora da primeira entrada no fuso do show e o portão) e vermelho (código inválido, ingresso desconhecido, cancelado, de outro show, portões fechados com a hora de abertura). Cores fixas nos dois temas, ícone e texto grandes, vibração e bipe (Web Audio, sem arquivo de som; dá para desligar), anúncio numa região `aria-live="assertive"`. Some sozinho (2,5 s no verde, 5 s nos outros), com um toque, com "Próxima leitura" ou com Esc.
- **Repetições:** a câmera vê o mesmo QR várias vezes por segundo. O mesmo código é ignorado enquanto continua na frente da câmera e por 5 s depois que sai dela (janela deslizante), e nada é lido com resultado na tela ou leitura a caminho. O código digitado sempre segue.
- **Resposta perdida:** se uma leitura falha na rede e a seguinte, do mesmo código, volta "já utilizado" pelo mesmo portão em até 2 minutos, é a mesma pessoa (a primeira chegou ao servidor): a tela mostra verde, não amarelo.
- **Contador:** entradas no show e por este portão (`GET /checkins/shows/{id}/summary` a cada 15 s, e +1 na hora a cada entrada liberada), e as 5 últimas leituras.

## Painel: financeiro e cupons

Cada show do painel tem uma moldura com o cabeçalho e três abas (`mat-tab-nav-bar`): Ao vivo, Financeiro e Cupons. O documento do show é buscado uma vez pela moldura (`ProducerShowContext`) e lido pelas abas.

- **Financeiro:** as linhas na ordem da fórmula (vendas brutas − descontos − reembolsos − taxa absorvida = valor a receber), cada uma com a explicação de onde vem, a fórmula com os números e a taxa paga pelos compradores à parte, como informação. Selo "Parcial" ou "Final". "Receber PDF por e-mail" pede o relatório (`202`) e avisa num toast. Os pedidos com reembolso travado (`REFUND_FAILED`) aparecem com "Tentar reembolso de novo"; o ID curto é o fim do UUID, porque o começo de um UUID v7 é o horário.
- **Cupons:** usos sobre o limite (barra com `role="meter"`), restantes, desconto dado, validade no fuso do show e setores; pausar e retomar. O formulário valida o código (3 a 30 caracteres, sem acento), o percentual (inteiro de 1 a 100), o valor fixo em reais (convertido para centavos sem ponto flutuante: `"19,99"` vira `1999`, e `"1.234,56"` também é aceito), o limite de usos e a validade, digitada no horário do local do show e convertida para UTC só com `Intl` ([`core/format/zoned-time.ts`](src/app/core/format/zoned-time.ts)). Código repetido (`coupon-code-taken`) aparece no campo.
- **Cancelar o show** (publicado ou à venda): um diálogo explica que todo pedido confirmado é reembolsado automaticamente e só libera o botão com o nome do show digitado.

## QR code do ingresso

O pedido traz `tickets[].code` (`LOTOU1.<ticketId>.<assinatura>`, assinado com HMAC pelo order-service, ADR 15), e a tela do pedido desenha um QR por ingresso. Ingressos emitidos antes do código assinado mostram "QR indisponível"; um ingresso cancelado ou já usado não mostra QR.

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

O orçamento do pacote inicial é de 600 kB: a biblioteca de OIDC (cerca de 120 kB) precisa estar no pacote inicial, porque a sessão é resolvida antes da primeira rota. O Material fica nos pacotes de cada tela; o cabeçalho usa só HTML e CSS. O painel do produtor, a portaria e as bibliotecas de QR code (a que desenha e a que lê) ficam fora do pacote inicial. A portaria exige uma conta com o papel `gate-staff`.
