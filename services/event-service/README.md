# event-service

Shows, locais, setores e busca. Node, NestJS 12, MongoDB e Redis.

É o dono do catálogo: o produtor cadastra locais e shows, publica, e a loja busca e exibe. Os lotes daqui são a configuração do produtor; o que está à venda agora, o preço e o estoque ficam com o inventory-service. O catálogo sai para os outros serviços pelo tópico `shows.catalog` do Kafka (seção [Kafka](#kafka)) e, enquanto o inventory não troca, também pela API interna.

Um job avança o show pelo horário: `PUBLISHED` vira `ON_SALE` na abertura das vendas e `SALES_CLOSED` no encerramento. Sem datas agendadas, as vendas abrem na publicação e fecham no início do show. Publicar exige local e ao menos um lote em cada setor.

## API

Atrás do gateway, as rotas ganham o prefixo `/api` (`/api/v1/shows`).

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/v1/shows` | público | busca por `artist`, `city`, `from` e `to`, paginada por cursor (cache de 60 s) |
| `GET` | `/v1/shows/:id` | público | página do show; rascunho só para o dono (cache de 10 min) |
| `POST` | `/v1/shows` | produtor | cria o show como `DRAFT` (exige `Idempotency-Key`) |
| `PATCH` | `/v1/shows/:id` | dono | altera os campos enviados; exige a `version` lida. `serviceFeePaidBy` (`BUYER`, o padrão, ou `PRODUCER`) diz quem paga a taxa de serviço de 10% e só muda antes de as vendas abrirem |
| `POST` | `/v1/shows/:id/publish` | dono | `DRAFT` → `PUBLISHED`; exige local, setor e um lote em cada setor |
| `POST` | `/v1/shows/:id/cancel` | dono | `PUBLISHED` ou `ON_SALE` → `CANCELLED`; o `ShowUpdated` leva o order-service a reembolsar todos os pedidos confirmados |
| `GET` | `/v1/venues` | público | lista locais, paginada por cursor |
| `GET` | `/v1/venues/:id` | público | detalhe do local |
| `POST` | `/v1/venues` | produtor | cadastra o local (exige `Idempotency-Key`) |
| `PATCH` | `/v1/venues/:id` | quem cadastrou | altera nome, endereço ou setores |
| `GET` | `/health/live`, `/health/ready` | público | health check |

Erros saem em Problem Details (RFC 9457), com `type` no formato `urn:lotou:problem:<tipo>` e o `traceId` da requisição:

| Tipo | Status | Quando |
| --- | --- | --- |
| `validation-error` | 400 | campo inválido ou `Idempotency-Key` ausente; `errors` lista cada campo |
| `unauthorized` | 401 | token ausente, expirado ou inválido |
| `forbidden` | 403 | usuário sem o papel exigido |
| `not-found` | 404 | recurso inexistente, ou rascunho de outro produtor |
| `version-conflict` | 409 | a `version` enviada está desatualizada |
| `invalid-state-transition` | 409 | transição de estado fora da tabela |
| `show-not-editable` | 409 | show num estado que não aceita edição |
| `venue-in-use` | 409 | mudança de setores num local com shows |
| `request-in-progress` | 409 | mesma `Idempotency-Key` ainda em processamento |
| `business-rule-violation` | 422 | regra de negócio violada (ex.: soma dos lotes acima da capacidade) |
| `show-not-publishable` | 422 | falta local, setor ou lote para publicar |
| `idempotency-key-reused` | 422 | mesma `Idempotency-Key` com outro corpo |
| `rate-limited` | 429 | limite de leituras do catálogo atingido; `Retry-After` diz quando tentar de novo |

## Cache e rate limit

As leituras públicas do catálogo passam pelo Redis (seção "Estratégia de cache e Redis" de `docs/projeto.md`). O Redis nunca derruba uma leitura: fora do ar ou lento (cada comando tem teto de 150 ms), a leitura vai ao MongoDB e o rate limit deixa passar.

**Página do show** (`GET /v1/shows/:id`), cache-aside em dois níveis:

- L1 na memória do processo, por 2 s e até 1.000 shows, para a chave quente da abertura de vendas.
- L2 no `redis-cache`, chave `cache:event:{id}`, com a `ShowResponse` pronta em JSON por 10 min mais um jitter de até 60 s.
- Show inexistente ou em rascunho fica 30 s no cache negativo, como 404 para quem não está autenticado. Com token, a leitura vai ao MongoDB: o dono enxerga o próprio rascunho, que nunca entra no cache como página.
- Na chave fria, só uma requisição por show vai ao MongoDB (`SET cache:lock:event:{id} NX PX 2000`); as outras releem o Redis a cada 50 ms por até 1 s e, se o valor não aparecer, vão ao banco.
- Alterar ou publicar o show, abrir ou encerrar as vendas pelo job e renomear o local ou mudar o endereço apagam a chave (nunca reescrevem) e repetem a deleção 500 ms depois (*delayed double delete*). O L1 das outras instâncias expira sozinho.
- `LotSoldOut` e `LotOpened` do inventory também apagam a chave (seção [Kafka](#kafka)).

**Busca** (`GET /v1/shows`): chave `cache:events:{sha256 da consulta}`, com a consulta já validada e normalizada (`?artist=Céu` e `?artist=ceu` dividem a chave). Sai só pelo TTL de 60 s: a listagem aceita até 1 minuto de atraso.

A métrica `cache_requests_total{prefix, result}` conta cada leitura: `prefix` é `event` ou `events`, e `result` é `l1_hit`, `hit`, `negative_hit`, `miss` ou `error` (Redis falhou). `SHOW_CACHE_ENABLED=false` desliga os dois caches, para o teste de carga com e sem cache.

**Rate limit** das leituras públicas (`GET /v1/shows*` e `GET /v1/venues*`): janela deslizante feita à mão num sorted set do `redis-core`, para comparar com o token bucket do gateway. A chave é `rl:{sub}` com token válido e `rl:ip:{sha256 do IP}` sem token; o IP cru nunca vai para o Redis. Um script Lua faz `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD` e `PEXPIRE` de uma vez, com a hora do próprio Redis. Toda resposta leva `RateLimit-Limit` e `RateLimit-Remaining`; acima do limite, 429 com `Retry-After`. O IP vem do `X-Forwarded-For` dos proxies em que `TRUST_PROXY` confia.

## Kafka

O serviço publica o catálogo em `shows.catalog` e lê `inventory.events`. Os contratos estão em [`contracts/`](../../contracts/README.md); o cliente é o `@confluentinc/kafka-javascript` (librdkafka, com a API do KafkaJS).

### O que publica: `shows.catalog`

| Mensagem | Quando |
| --- | --- |
| `ShowPublished` | o show sai do rascunho (`POST /v1/shows/:id/publish`) |
| `ShowUpdated` | toda mudança depois disso: edição do produtor (dados, setores, lotes), abertura e encerramento das vendas pelo job, e nome ou endereço do local copiados para os shows dele |

Rascunho nunca sai do serviço. A chave é o `showId`, então todas as mensagens de um show caem na mesma partição, em ordem. O payload é o show inteiro, com a `version` que sobe a cada mudança (toda escrita faz `$inc: { version: 1 }`): o consumidor guarda a versão mais alta e ignora as outras, e o tópico compactado fica com a última de cada show. Descrição, campos de busca e `publishedAt` não vão para o tópico.

**Outbox transacional** ([ADR 29](../../docs/adr/0029-outbox-do-event-service-no-mongodb.md)). Quem muda o show grava, na mesma transação do MongoDB, um documento na coleção `outbox` com a mensagem pronta e o `traceparent` da requisição. Se o processo cair depois do commit, a mensagem continua lá; se a transação falhar, nem o show nem a mensagem mudam. Por isso o MongoDB roda como replica set (`rs0`), mesmo com um nó só.

O **relay** publica o outbox:

- A cada `OUTBOX_POLL_INTERVAL_MS`, a instância dona do lease (`outbox_leases`, tomado com `findOneAndUpdate` e a hora do próprio MongoDB, vale 10 s) lê até 100 pendentes, da mais antiga para a mais nova, mais todas as pendentes dos mesmos shows.
- Publica cada show em ordem crescente de versão e nunca publica uma versão menor que a última já publicada daquele show. Uma marcação que ficou pela metade, ou uma republicação que chegou depois de uma mudança, é descartada.
- O lote vai numa transação do Kafka. O `transactional.id` é o mesmo em todas as instâncias: quando uma nova dona conecta, o broker aborta a transação aberta da anterior e recusa o que ela tentar publicar depois. Assim uma instância que travou com um lote na mão não consegue publicar uma versão velha depois da nova dona.
- Depois do commit, marca as mensagens com `publishedAt`; um índice TTL as apaga 7 dias depois.
- Se cair entre publicar e marcar, o lote sai de novo, inteiro e na mesma ordem (pelo menos uma vez). Os consumidores devem ler com `isolation.level=read_committed`, para não verem lotes abortados.
- Com o Kafka fora, a API continua aceitando escritas; o outbox acumula e sai quando o Kafka volta.

Para um ambiente que já tinha shows antes do Kafka, `npm run catalog:republish` (no Compose: `docker compose exec event-service npm run catalog:republish`) põe no outbox o snapshot atual de todo show publicado, como `ShowUpdated`, e o relay os publica. Só lê a `MONGODB_URI`; rodar duas vezes só repete mensagens, que os consumidores ignoram pela versão.

### O que consome: `inventory.events`

Grupo `event-service`. Em `LotSoldOut` e `LotOpened`, apaga `cache:event:{showId}` no `redis-cache`, para a próxima leitura recarregar o show (Fluxo C). Hoje a página não mostra o lote em venda (lote, preço e estoque vêm da disponibilidade do inventory), então a deleção só garante que nada do que mudar nela fique 10 minutos no cache.

- Os outros tipos, e versões que o serviço não conhece, são ignorados.
- Apagar uma chave é idempotente, então a mensagem repetida não precisa ser registrada. O offset é confirmado depois do tratamento (pelo menos uma vez).
- Se o Redis falhar, tenta 3 vezes (espera de 200 e 400 ms). Depois disso, ou se a mensagem for malformada, ela vai para `inventory.events.dlt` com os cabeçalhos de origem no formato do Spring Kafka (`kafka_dlt-original-topic`, `-partition`, `-offset`, `-consumer-group` e `kafka_dlt-exception-message`), e a partição segue.
- Só o L1 da instância que consumiu é apagado; o das outras expira sozinho em até 2 s.
- Um grupo novo começa do início do tópico: apagar o cache de shows antigos não faz mal, e nenhum evento se perde antes da primeira leitura.

### Trace e métricas

O `traceparent` gravado no outbox vira o pai do span `send shows.catalog` (produtor), e o contexto desse span vai no cabeçalho da mensagem. Do outro lado, `process inventory.events` (consumidor) continua o trace do cabeçalho, e o `DEL` no Redis aparece dentro dele. Quando há shows a avançar, o job de abertura e encerramento das vendas abre um span próprio (`show-lifecycle ON_SALE`, `show-lifecycle SALES_CLOSED`), então as mensagens dele também têm trace.

| Métrica | O que mede |
| --- | --- |
| `outbox_pending` | mensagens esperando o relay |
| `outbox_oldest_pending_age_seconds` | idade da pendente mais antiga: o atraso do catálogo no Kafka |
| `outbox_published_total{topic, type}` | mensagens publicadas |
| `outbox_publish_failures_total{topic}` | lotes que falharam (o relay tenta de novo na rodada seguinte) |
| `kafka_messages_consumed_total{topic, type, result}` | mensagens lidas; `result` é `processed`, `ignored` ou `dead_lettered` |

Os dois gauges do outbox contam a coleção inteira, então todas as instâncias informam o mesmo valor: no painel, use `max`.

## Estrutura

```
src/
├── instrumentation.ts   # OpenTelemetry, carregado antes da aplicação
├── main.ts, app.module.ts, app.setup.ts
├── config/              # variáveis de ambiente validadas na subida
├── auth/                # validação do JWT, @Public(), @Roles(), @CurrentUser()
├── redis/               # conexões com redis-cache e redis-core, lock com token
├── cache/               # L1 em memória e métrica cache_requests_total
├── kafka/               # cliente do Kafka e envelope das mensagens
├── outbox/              # outbox no MongoDB e relay para o Kafka (ADR 29)
├── inventory-events/    # consumidor de inventory.events (cache da página)
├── telemetry/           # encerramento do SDK e contexto de trace nos cabeçalhos
├── rate-limit/          # janela deslizante no redis-core e @RateLimited()
├── common/
│   ├── problem/         # Problem Details: exceção, filtro global e validação
│   ├── idempotency/     # Idempotency-Key no MongoDB (ADR 22)
│   ├── pagination/      # cursor
│   ├── ids/             # UUID v7
│   └── text/            # normalização para busca
├── venues/              # locais e setores
├── shows/               # shows, tabela de estados, regras e mensagens do catálogo
│   └── cache/           # cache da página e da busca
├── health/
└── republish-catalog.ts # npm run catalog:republish
test/                    # testes de integração (Testcontainers)
```

## Comandos

```bash
npm ci
npm test           # unitários: regras de domínio, sem banco
npm run test:e2e   # integração: aplicação inteira contra MongoDB, Redis e Kafka reais (precisa de Docker)
npm run lint
npm run build
```

Os testes unitários validam as mensagens publicadas contra os schemas de `contracts/` (ajv) e leem os exemplos do inventory. Os de integração sobem o Kafka 4.2 em KRaft e provam: mensagem no tópico conforme o contrato, versões em ordem, nada perdido numa queda entre gravar e publicar, nada publicado em dobro ou fora de ordem com duas instâncias, e o produtor de uma instância que travou cercado pela nova dona. O relay e o consumidor ficam desligados nos testes que não precisam do Kafka.

Para rodar fora do Compose, com a infraestrutura de pé (`make infra` na raiz). Do host, a conexão com o MongoDB precisa de `directConnection=true`: o membro do replica set se anuncia como `mongodb:27017`, nome que só existe dentro do Compose.

```bash
MONGODB_URI='mongodb://localhost:27017/event_service?directConnection=true' \
REDIS_CACHE_URL=redis://localhost:6379 \
REDIS_CORE_URL=redis://localhost:6380 \
KAFKA_BROKERS=localhost:9094 \
AUTH_ISSUER=http://localhost:8180/realms/lotou \
AUTH_JWKS_URI=http://localhost:8180/realms/lotou/protocol/openid-connect/certs \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
npm run build && npm run start:prod
```

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `3000` | porta HTTP |
| `MONGODB_URI` | — | conexão com o MongoDB; precisa ser replica set (transações). Do host, com `directConnection=true` |
| `REDIS_CACHE_URL` | — | conexão com o `redis-cache` (cache da página e da busca) |
| `REDIS_CORE_URL` | — | conexão com o `redis-core` (rate limit) |
| `KAFKA_BROKERS` | `localhost:9094` | brokers do Kafka, separados por vírgula (no Compose, `kafka:9092`) |
| `OUTBOX_RELAY_ENABLED` | `true` | liga o relay do outbox; desligado, as mensagens se acumulam no outbox |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | intervalo do relay quando não há mensagens pendentes |
| `OUTBOX_TRANSACTIONAL_ID` | `event-service-outbox` | `transactional.id` do produtor do relay; o mesmo em todas as instâncias |
| `INVENTORY_EVENTS_CONSUMER_ENABLED` | `true` | liga o consumidor de `inventory.events` |
| `KAFKA_CONSUMER_GROUP` | `event-service` | grupo do consumidor |
| `SHOW_CACHE_ENABLED` | `true` | liga o cache da página e da busca |
| `RATE_LIMIT_ENABLED` | `true` | liga o rate limit das leituras do catálogo |
| `RATE_LIMIT_MAX` | `120` | leituras aceitas por janela, por usuário ou IP |
| `RATE_LIMIT_WINDOW_MS` | `10000` | tamanho da janela deslizante |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | de quais proxies aceitar o `X-Forwarded-For` (o `trust proxy` do Express) |
| `AUTH_ISSUER` | — | emissor esperado no JWT (URL pública do realm) |
| `AUTH_JWKS_URI` | — | de onde baixar as chaves públicas do realm |
| `AUTH_AUDIENCE` | `lotou-api` | audiência esperada no JWT |
| `SHOW_LIFECYCLE_INTERVAL_MS` | `1000` | intervalo do job de abertura e encerramento das vendas (0 desliga) |
| `LOG_LEVEL` | `info` | nível do log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | endereço do OTel Collector |
