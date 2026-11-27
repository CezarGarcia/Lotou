# analytics-service

Vendas, relatório financeiro, pedidos e o painel ao vivo do produtor. Python 3.13, FastAPI, aiokafka, MongoDB (PyMongo assíncrono) e Redis (`redis-core`).

Consome `shows.catalog`, `order.events`, `inventory.events` e `checkin.events` e mantém read models no MongoDB (banco `analytics`). Não é dono de dado nenhum: tudo aqui pode ser apagado e reconstruído a partir do Kafka, e o replay faz isso sem tirar o painel do ar ([ADR 30](../../docs/adr/0030-replay-dos-read-models.md)). É também o hub de tempo real do painel: métricas a cada segundo e feed de atividade por WebSocket ([ADR 31](../../docs/adr/0031-hub-de-tempo-real-so-para-o-painel.md)).

## Read models

| Coleção | Um documento por | Conteúdo | Vem de |
| --- | --- | --- | --- |
| `shows` | show | cópia do catálogo: título, artista, produtor, status, local e fuso, setores com capacidade e lotes, e quem paga a taxa. Fica a `version` mais alta | `ShowPublished`, `ShowUpdated` |
| `sales_by_sector` | show, setor e hora (UTC) | ingressos vendidos, receita em centavos, pedidos e a divisão por lote, líquidos de reembolso | `OrderConfirmed`, `OrderRefunded` |
| `producer_statements` | show | relatório financeiro (veja abaixo), pedidos criados, confirmados, cancelados (por motivo) e reembolsados, ingressos vendidos, reembolsados e emitidos, e se o relatório é parcial | eventos do pedido e o status do show |
| `order_view` | pedido | estado, valores (subtotal, desconto, taxa e quem a paga, cupom), itens com setor, lote, cadeira e preço, ingressos com estado (`VALID`, `USED` com portão e hora, `CANCELLED`), reembolso (valor, motivo, hora, falhas), linha do tempo e o resumo do show (título, data e local) | eventos do pedido, `TicketCheckedIn` e o catálogo |
| `lot_timeline` | lote | quando abriu (com preço e quantidade) e quando esgotou, em ordem | `LotOpened`, `LotSoldOut` |
| `checkins_by_gate` | show e portão | entradas na portaria, a primeira e a última | `TicketCheckedIn` |

- **Ocupação** (vendidos / capacidade) é calculada na leitura, com a capacidade do catálogo, por setor e no total.
- **Receita** (`revenueCents` nas vendas, na lista de shows e no painel ao vivo) é sempre o valor líquido dos ingressos: preço da reserva menos o desconto do cupom, sem a taxa de serviço e sem os pedidos reembolsados. O desconto é por pedido e, se um pedido tivesse mais de um lote, seria dividido entre eles na proporção do valor (arredondado para baixo, o centavo que sobra fica com o primeiro). Somada no show inteiro, a receita é bruto − descontos − reembolsos do relatório. Um pedido reembolsado sai das vendas na hora (UTC) em que foi vendido, e os ingressos dele voltam a contar como disponíveis no painel.
- `ReservationConfirmed`, `ReservationReleased` e `ReservationReturned` são lidos e ignorados de propósito: o pedido confirmado, cancelado ou reembolsado já traz a mesma informação, com o motivo. `CheckinRejected` também: leitura recusada não muda ingresso nenhum.

### Relatório financeiro

Contrato em [`contracts/api-fase-6.md`](../../contracts/api-fase-6.md). Em centavos:

| Campo | O que soma |
| --- | --- |
| `grossSalesCents` | subtotal (ingressos ao preço da reserva) de todo pedido que chegou a `CONFIRMED`, reembolsado ou não |
| `discountsCents` | desconto do cupom desses mesmos pedidos |
| `refundsCents` | subtotal − desconto dos pedidos reembolsados (estorno concluído, `OrderRefunded`) |
| `platformFeeCents` | taxa de serviço dos pedidos em que o produtor absorve a taxa (`PRODUCER`), menos a dos reembolsados |
| `buyerFeesCents` | taxa paga pelos compradores (`BUYER`), menos a dos reembolsados; informativa, não entra no valor a receber |
| `receivableCents` | bruto − descontos − reembolsos − taxa absorvida (`docs/projeto.md`, "Financeiro") |
| `refundedOrders`, `ticketsRefunded` | pedidos e ingressos reembolsados |

**Reembolso.** O pedido reembolsado continua nas vendas brutas e no desconto, porque foi vendido; o que o produtor recebeu por ele (subtotal − desconto) vai para os reembolsos. A taxa dele sai da taxa absorvida: o estorno devolve ao comprador tudo o que ele pagou, taxa incluída, e a plataforma não fica com taxa de pedido estornado, então não a cobra do produtor. Assim um pedido reembolsado soma zero no valor a receber, com o show repassando ou absorvendo a taxa. A alternativa, manter a taxa absorvida de um pedido estornado, faria o produtor pagar por uma venda que não aconteceu. Só o estorno concluído conta: um pedido em `REFUNDING` ou `REFUND_FAILED` ainda está com o dinheiro do comprador e continua no valor a receber.

Exemplo (o cenário dos testes, `tests/scenario.py`): no show B, o produtor absorve a taxa; 2 × 90,00 sem cupom, 3 × 90,00 com cupom de 15% e 1 × 90,00 reembolsado. Bruto 540,00; descontos 40,50; reembolsos 90,00; taxa absorvida 18,00 + 27,00 = 45,00 (os 9,00 do reembolsado não entram); a receber 540,00 − 40,50 − 90,00 − 45,00 = 364,50, que é exatamente o que os dois pedidos que ficaram rendem ao produtor (162,00 + 202,50).

O relatório é parcial até o show ficar `FINISHED` no catálogo.
- Dinheiro em centavos (inteiro de 64 bits no MongoDB); datas em UTC. O `buyerId` fica no `order_view`, mas não sai na API do produtor. CPF e e-mail não existem nos eventos.

Fora das gerações fica `activity_log`: o `eventId` de cada fato que já foi para o feed do painel, para o replay não repeti-lo (veja "Painel ao vivo").

Cada coleção tem o número da geração no nome (`order_view_g3`). Uma view com o nome sem sufixo (`order_view`) aponta sempre para a geração ativa, para quem lê o banco de fora (o producer-assistant, o mongosh).

## Idempotência e ordem

O Kafka entrega ao menos uma vez, e a ordem só é garantida por chave (pedido no `order.events`, show no catálogo e no inventory). As projeções não dependem de nenhuma das duas coisas:

- **Uma transação por lote de partição.** O efeito de cada mensagem e o `eventId` dela em `processed_events` são gravados juntos; o offset só é confirmado depois. Repetição encontra o `eventId` e não faz nada.
- **Show:** fica a versão mais alta; uma versão antiga republicada é ignorada.
- **Pedido:** o estado anda pela tabela de transições do documento (`PENDING` → `CONFIRMED` ou `CANCELLED`; `CONFIRMED` → `REFUNDING` → `REFUNDED` ou `REFUND_FAILED`; `REFUND_FAILED` → `REFUNDING`). Cada fato é uma transição dela: `TicketsCancelled` leva de `CONFIRMED` a `REFUNDING`, `OrderRefundFailed` a `REFUND_FAILED` e `OrderRefunded` a `REFUNDED`. Um fato anterior que chega depois (o `OrderConfirmed` depois do `OrderRefunded`) só completa o documento; um fato à frente, cujo passo intermediário ainda não chegou, leva o pedido adiante pelo caminho da tabela. É assim que o reprocessamento manual (`REFUND_FAILED` → `REFUNDING`, sem evento próprio) aparece: o `OrderRefunded` seguinte leva o pedido a `REFUNDED`. Uma transição fora da tabela (estorno de pedido cancelado) é recusada e registrada em log.
- **Ingresso:** `VALID` → `USED` (`TicketCheckedIn`) ou `CANCELLED` (`TicketsCancelled`). A entrada vem de outro tópico e pode chegar antes do próprio pedido: fica guardada no `order_view`, e o estado de cada ingresso é recalculado com os fatos dele passando pela tabela na ordem da hora de cada um (entrou antes do cancelamento: fica `USED`).
- **Vendas e contadores** somam uma vez por tipo de fato do pedido (a confirmação, o estorno), quando o fato chega pela primeira vez, na frente ou atrás do estado; nem um `OrderConfirmed` repetido com outro `eventId` conta duas vezes. Tirar das vendas um pedido reembolsado precisa dos itens da confirmação, então quem chega por último faz isso: o estorno depois da confirmação subtrai da hora da venda; a confirmação depois do estorno entra zerada. Cada entrada na portaria conta uma vez por ingresso.
- **Pedido antes do show:** o `order_view` nasce com `show: null` e é preenchido quando o show chega (e atualizado se o título, a data ou o local mudarem). A transação que cria o `order_view` e a do catálogo gravam o mesmo documento do relatório, então o MongoDB não deixa as duas passarem juntas com uma leitura velha.

O resultado é o mesmo em qualquer ordem de chegada; um teste aplica a mesma noite de vendas embaralhada, com repetições, e compara documento a documento.

**Falhas:** mensagem fora do contrato (JSON inválido, campo faltando) vai direto para `<tópico>.dlt`; erro ao aplicar tenta `CONSUMER_MAX_ATTEMPTS` vezes e depois vai para a DLT, e o consumidor segue. Falha de infraestrutura (MongoDB fora, eleição no replica set) nunca vai para a DLT: o consumidor espera e tenta de novo, e o lag sobe. A mensagem na DLT leva a original, com a mesma chave e os cabeçalhos `dlt.original.topic`, `dlt.original.partition`, `dlt.original.offset`, `dlt.consumer.group`, `dlt.error.class` e `dlt.error.message`. Tipo desconhecido, ou versão que o serviço não conhece, é ignorado.

O consumidor usa `isolation_level=read_committed`: o relay do outbox do event-service publica o catálogo em transações Kafka, e mensagens de transações abortadas não chegam aos read models.

## Replay

Reconstrói todos os read models do começo dos tópicos (`order.events`, `inventory.events` e `checkin.events` não têm prazo de retenção, e `shows.catalog` é compactado), sem parar a leitura. O replay lê exatamente os tópicos do consumidor ao vivo (`analytics.contracts.TOPICS`). Os pedidos publicados antes da fase 6 não têm subtotal, desconto nem taxa: são lidos como eram cobrados (subtotal = total, sem cupom nem taxa).

1. toma o lock do replay (um por vez) e reserva a geração N+1, com coleções novas e o consumer group `analytics-service.gen-<N+1>`;
2. guarda o fim de cada partição naquele instante;
3. consome do começo até esses offsets. Enquanto isso, a API lê a geração N e o consumidor ao vivo continua alimentando a N;
4. confirma as posições no grupo da N+1 e troca o ponteiro (`analytics_state/active`) numa transação;
5. o supervisor de cada instância passa o consumidor ao vivo para o grupo da N+1, que continua de onde o replay parou;
6. depois de `RETIRED_GENERATION_GRACE_SECONDS`, apaga as coleções e o consumer group da N.

Se falhar, a geração nova fica `FAILED` e é apagada; a ativa não muda. Na primeira subida, a geração 1 nasce ativa e lê tudo do começo.

```bash
make replay-analytics        # na raiz, com o ambiente no ar: roda dentro do container
```

Ou `POST /internal/v1/replay` com o token de uma conta de serviço, e `GET /internal/v1/replay/{geração}` para acompanhar (`BUILDING`, `ACTIVE`, `FAILED`). A linha de comando sai com 0 (concluído), 1 (falhou) ou 2 (já havia um replay).

Como o nome do consumer group muda a cada replay, painéis e alertas de lag filtram por `analytics-service.gen-*`.

## API

Atrás do gateway, as rotas de `/v1` ganham o prefixo `/api` (`/api/v1/analytics/...`).

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/v1/analytics/shows` | produtor | os shows do produtor do token, do mais novo para o mais antigo, paginados por cursor (`limit` até 100, `cursor`): `showId`, `title`, `artist`, `startsAt`, `timezone`, `venueName`, `city`, `status`, `ticketsSold` e `revenueCents` |
| `GET` | `/v1/analytics/shows/{showId}/sales` | produtor dono do show | por setor: vendidos, capacidade, ocupação, receita, pedidos, lotes (vendas e linha do tempo) e série por hora (UTC); o mesmo no total |
| `GET` | `/v1/analytics/shows/{showId}/statement` | produtor dono do show | relatório financeiro do show |
| `GET` | `/v1/analytics/shows/{showId}/orders` | produtor dono do show | pedidos do show, do mais novo para o mais antigo, paginados por cursor (`limit` até 100, `cursor`, `status`, inclusive `REFUNDING`, `REFUND_FAILED` e `REFUNDED`) |
| `GET` | `/internal/v1/shows/{showId}/statement` | conta de serviço | o mesmo relatório, com `producerId`, `artist`, `startsAt`, `timezone` e `venueName`, para o PDF do notification-service, que confere se quem pediu é o dono |
| `POST` | `/internal/v1/replay` | conta de serviço | começa um replay; 202 com `Location` |
| `GET` | `/internal/v1/replay/{generation}` | conta de serviço | situação do replay |
| WebSocket | `/v1/analytics/live` | produtor, autenticado na primeira mensagem | painel ao vivo (veja abaixo) |
| `GET` | `/health/live`, `/health/ready` | público | vivo; pronto (MongoDB e Redis respondem e o consumidor está rodando) |

O token é validado aqui também (ADR 21): assinatura pelo JWKS do realm, em cache e rebuscado só quando aparece um `kid` desconhecido, emissor, audiência `lotou-api` e validade. As rotas `/internal` não têm rota no gateway. O `POST /internal/v1/replay` não exige `Idempotency-Key`: enquanto um replay roda, outro pedido recebe 409, e repetir depois só reconstrói o mesmo resultado.

Erros em Problem Details (RFC 9457), com `type` em `urn:lotou:problem:<tipo>` e o `traceId` da requisição:

| Tipo | Status | Quando |
| --- | --- | --- |
| `validation-error` | 400 | `showId` que não é UUID, `limit` fora da faixa ou cursor inválido; `errors` lista cada campo |
| `unauthorized` | 401 | token ausente, expirado ou inválido |
| `forbidden` | 403 | usuário sem o papel exigido |
| `not-found` | 404 | show que não existe ou que é de outro produtor (não revela que existe) |
| `replay-in-progress` | 409 | já existe um replay em andamento |
| `service-unavailable` | 503 | as chaves do Keycloak não puderam ser baixadas, ou a geração inicial ainda não existe |

## Painel ao vivo

O protocolo está em [`contracts/realtime-dashboard.md`](../../contracts/realtime-dashboard.md). Em resumo: o cliente abre o WebSocket, manda `auth` com o token em até 5 s (senão, 4408) e recebe `ready`; cada `subscribe` de um show dele devolve um `snapshot` (métricas de agora e as últimas 50 entradas do feed) e, daí em diante, `metrics` a cada segundo e `activity` a cada fato. O token é validado como na API HTTP; sem o papel `producer` fecha com 4403, e quando ele vence sem um `auth` novo, com 4401. Show de outro produtor recebe `error` `forbidden`. O ping de protocolo a cada 20 s é do uvicorn.

**Feed de atividade.** Quando o consumidor ao vivo aplica pela primeira vez um `OrderConfirmed`, `OrderCancelled`, `OrderRefunded`, `TicketCheckedIn` (a primeira entrada do ingresso), `LotOpened` ou `LotSoldOut`, a projeção monta a entrada (sem comprador: nem o `buyerId`; a entrada na portaria leva só setor e portão) e grava o `eventId` em `activity_log`, na mesma transação do efeito. Depois que a transação confirma, a entrada vai para o stream do show com `XADD MAXLEN ~ 1000` e `IDMP` (o `eventId` como ID da mensagem, para uma nova tentativa não duplicar). Assim o feed recebe cada fato uma vez só: nem uma repetição do Kafka, nem o replay (que não escreve no feed), nem o consumidor da geração nova reaplicando, depois da troca, o que a antiga aplicou durante o replay. Se o processo cair entre a transação e o `XADD`, aquela entrada se perde (o evento já está no `processed_events`): para um feed é aceitável, porque os números do painel vêm dos read models.

**Métricas.** O objeto `metrics` é calculado na geração ativa: `sales_by_sector` somado por setor (vendidos e receita líquidos), capacidade e nomes do catálogo (`remaining` = capacidade − vendidos), pedidos confirmados, cancelados e reembolsados do relatório, pedidos confirmados no último minuto (índice em `order_view`), entradas na portaria por portão (`checkins_by_gate`) e o lote atual de cada setor pela linha do tempo dos lotes.

**Várias instâncias** ([ADR 32](../../docs/adr/0032-painel-ao-vivo-com-varias-instancias.md)). Cada instância guarda as assinaturas dos seus WebSockets e roda quatro tarefas no Redis:

| Tarefa | Como |
| --- | --- |
| interesse | a cada segundo, renova em `dashboard:watched` (ZSET, score = até quando, 5 s à frente) os shows com assinante nesta instância; uma instância que morre para de renovar e o interesse vence sozinho |
| cálculo | no começo de cada segundo, toda instância lê os shows assistidos e disputa o segundo de cada um num script Lua (`dashboard:metrics-tick:{showId}`); só quem ganha calcula e faz `PUBLISH dashboard.metrics:{showId}`. Sem líder: um cálculo por show por segundo no total, e cair uma instância não muda nada |
| métricas | uma conexão de pub/sub, assinando só os canais dos shows com assinante aqui |
| atividade | um `XREAD BLOCK` em todos os streams dos shows assinados aqui, com um cursor por stream |

A assinatura é registrada antes da foto (`XREVRANGE`): o que o leitor traz enquanto a foto é montada fica guardado, e cada assinatura só recebe IDs maiores que o último recebido. Nada se perde nem se repete entre a foto e o ao vivo.

**Cliente lento.** Cada WebSocket tem uma fila e uma task de envio, e o repasse nunca espera um cliente. Métricas são substituíveis: fica só a mais recente de cada show. Atividade nunca é descartada: com mais de `LIVE_MAX_PENDING_FRAMES` frames na fila, ou um envio parado por 10 s, a conexão fecha com 1013 e o cliente reconecta e recebe a foto.

| Chave no `redis-core` | Tipo | Para quê |
| --- | --- | --- |
| `stream:activity:{showId}` | stream, `MAXLEN ~ 1000` | feed de atividade |
| `dashboard.metrics:{showId}` | canal de pub/sub | métricas, 1 vez por segundo enquanto alguém assiste |
| `dashboard:watched` | sorted set | shows com alguém no painel, em qualquer instância |
| `dashboard:metrics-tick:{showId}` | string, 5 s | último segundo calculado: quem grava calcula |

**Latência.** O critério da fase 4 é "evento chega ao painel em menos de 2 s". O histograma `dashboard_event_delay_seconds{type}` mede do `occurredAt` do fato até o envio do frame `activity`, e o teste de integração confere o critério com duas instâncias, do publish no Kafka ao frame recebido pelo cliente.

## Observabilidade

OpenTelemetry configurado no código, antes do cliente do MongoDB e da aplicação (`analytics/telemetry.py`): spans HTTP (FastAPI, menos o health check), um span por comando do MongoDB e, para cada mensagem do Kafka, um span `<tópico> process` filho do trace de quem publicou (cabeçalho `traceparent`). Logs em JSON no console, com `trace_id` e `span_id`, e também por OTLP. Métricas: `analytics_events_total{topic, type, result, consumer}` (`applied`, `duplicate`, `ignored`, `dead_lettered`) e `analytics_batch_duration` por tópico. O lag por consumer group vem do exporter do Kafka.

Painel ao vivo: `dashboard_event_delay_seconds` (histograma, do fato ao envio do frame), `dashboard_connections` e `dashboard_subscriptions` (contadores que sobem e descem, por instância). Spans: `analytics live connect` (da abertura à primeira autenticação), `analytics live auth` (renovação) e `analytics live subscribe` (com a foto); frames não viram span, e a rota do WebSocket fica fora da instrumentação ASGI, que abriria um span por frame. Os comandos do Redis também viram span (o `XADD` aparece no trace do evento do Kafka); os das tarefas de fundo do painel, que rodam a cada segundo, ficam de fora para não gerar um trace por segundo.

## Estrutura

```
src/analytics/
├── __main__.py            # python -m analytics: sobe a API e o consumidor
├── config.py              # variáveis de ambiente validadas na subida
├── telemetry.py           # OpenTelemetry e logs em JSON
├── contracts.py           # leitura das mensagens (contracts/ na raiz)
├── domain/                # regras puras: estado do pedido, relatório, cópia do show
├── projection.py          # aplica um evento aos read models, numa transação
├── kafka/                 # consumidor por geração, DLT e operações de admin
├── store/                 # gerações, ponteiro, lock do replay e coleções
├── supervisor.py          # consumidor ao vivo na geração ativa e limpeza das antigas
├── replay/                # replay: execução, disparo pela API e linha de comando
├── live/                  # painel ao vivo: protocolo, feed, métricas, hub no Redis, fila de envio e WebSocket
└── api/                   # rotas, JWT, Problem Details, paginação e respostas
tests/
├── unit/                  # regras, contratos (exemplos e JSON Schema), JWT, respostas, protocolo do painel
└── integration/           # MongoDB, Kafka e Redis reais (Testcontainers), replay e painel de ponta a ponta
```

## Comandos

```bash
uv sync
uv run pytest tests/unit          # unitários
uv run pytest tests/integration   # MongoDB (replica set), Kafka e Redis reais; precisa de Docker
uv run ruff check && uv run ruff format --check
uv run mypy
```

Na raiz, `make test-analytics-service` roda tudo isso. Os testes de integração usam as imagens do Compose (`mongo:8.0`, `apache/kafka:4.2.0`, `redis:8.8-alpine`) e conferem as mensagens montadas contra os JSON Schemas de `contracts/`.

Para rodar fora do Compose, com a infraestrutura de pé (`make infra` na raiz):

```bash
MONGODB_URI="mongodb://localhost:27017/analytics?directConnection=true" \
KAFKA_BROKERS=localhost:9094 \
REDIS_URL=redis://localhost:6380 \
AUTH_ISSUER=http://localhost:8180/realms/lotou \
AUTH_JWKS_URI=http://localhost:8180/realms/lotou/protocol/openid-connect/certs \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
uv run python -m analytics
```

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `8084` | porta HTTP |
| `MONGODB_URI` | — | conexão com o MongoDB (replica set: as projeções usam transação); o banco vem do caminho, ou `analytics` |
| `KAFKA_BROKERS` | `localhost:9094` | endereço do Kafka |
| `KAFKA_GROUP_ID` | `analytics-service` | prefixo dos consumer groups (`<prefixo>.gen-<N>`) |
| `REDIS_URL` | `redis://localhost:6380` | o `redis-core` (Redis 8.6 ou mais novo: o feed usa `XADD IDMP`) |
| `AUTH_ISSUER` | — | emissor esperado no JWT (URL pública do realm) |
| `AUTH_JWKS_URI` | — | de onde baixar as chaves públicas do realm |
| `AUTH_AUDIENCE` | `lotou-api` | audiência esperada no JWT |
| `CONSUMER_BATCH_SIZE` | `500` | mensagens lidas por vez; cada lote de uma partição é uma transação |
| `CONSUMER_MAX_ATTEMPTS` | `5` | tentativas de uma mensagem que falha antes de ir para a DLT |
| `GENERATION_POLL_SECONDS` | `1` | de quanto em quanto tempo o supervisor confere a geração ativa |
| `RETIRED_GENERATION_GRACE_SECONDS` | `30` | quanto tempo a geração aposentada fica de pé depois da troca |
| `PROCESSED_EVENTS_TTL_DAYS` | `30` | por quanto tempo o `eventId` processado é guardado |
| `REPLAY_LEASE_SECONDS` | `60` | validade do lock do replay, renovado enquanto ele anda |
| `LIVE_AUTH_TIMEOUT_SECONDS` | `5` | prazo da primeira mensagem `auth` no WebSocket do painel |
| `LIVE_MAX_SUBSCRIPTIONS` | `20` | shows por conexão do painel |
| `LIVE_MAX_PENDING_FRAMES` | `500` | frames que não podem ser descartados na fila de um cliente lento; passou disso, a conexão fecha com 1013 |
| `LOG_LEVEL` | `INFO` | nível do log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | endereço do OTel Collector |
| `OTEL_SDK_DISABLED` | `false` | desliga o OpenTelemetry (testes) |
