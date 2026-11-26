# event-service

Shows, locais, setores e busca. Node, NestJS 12, MongoDB e Redis.

É o dono do catálogo: o produtor cadastra locais e shows, publica, e a loja busca e exibe. Os lotes daqui são a configuração do produtor; o que está à venda agora, o preço e o estoque ficam com o inventory-service, que lê o catálogo por uma API interna.

Um job avança o show pelo horário: `PUBLISHED` vira `ON_SALE` na abertura das vendas e `SALES_CLOSED` no encerramento. Sem datas agendadas, as vendas abrem na publicação e fecham no início do show.

## API

Atrás do gateway, as rotas ganham o prefixo `/api` (`/api/v1/shows`).

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/v1/shows` | público | busca por `artist`, `city`, `from` e `to`, paginada por cursor (cache de 60 s) |
| `GET` | `/v1/shows/:id` | público | página do show; rascunho só para o dono (cache de 10 min) |
| `POST` | `/v1/shows` | produtor | cria o show como `DRAFT` (exige `Idempotency-Key`) |
| `PATCH` | `/v1/shows/:id` | dono | altera os campos enviados; exige a `version` lida |
| `POST` | `/v1/shows/:id/publish` | dono | `DRAFT` → `PUBLISHED`; exige local, setor e lote |
| `GET` | `/v1/venues` | público | lista locais, paginada por cursor |
| `GET` | `/v1/venues/:id` | público | detalhe do local |
| `POST` | `/v1/venues` | produtor | cadastra o local (exige `Idempotency-Key`) |
| `PATCH` | `/v1/venues/:id` | quem cadastrou | altera nome, endereço ou setores |
| `GET` | `/internal/v1/catalog/shows` | conta de serviço | catálogo para os outros serviços, incremental por `updatedAfter` e cursor |
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

**Busca** (`GET /v1/shows`): chave `cache:events:{sha256 da consulta}`, com a consulta já validada e normalizada (`?artist=Céu` e `?artist=ceu` dividem a chave). Sai só pelo TTL de 60 s: a listagem aceita até 1 minuto de atraso.

A métrica `cache_requests_total{prefix, result}` conta cada leitura: `prefix` é `event` ou `events`, e `result` é `l1_hit`, `hit`, `negative_hit`, `miss` ou `error` (Redis falhou). `SHOW_CACHE_ENABLED=false` desliga os dois caches, para o teste de carga com e sem cache.

**Rate limit** das leituras públicas (`GET /v1/shows*` e `GET /v1/venues*`): janela deslizante feita à mão num sorted set do `redis-core`, para comparar com o token bucket do gateway. A chave é `rl:{sub}` com token válido e `rl:ip:{sha256 do IP}` sem token; o IP cru nunca vai para o Redis. Um script Lua faz `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD` e `PEXPIRE` de uma vez, com a hora do próprio Redis. Toda resposta leva `RateLimit-Limit` e `RateLimit-Remaining`; acima do limite, 429 com `Retry-After`. O IP vem do `X-Forwarded-For` dos proxies em que `TRUST_PROXY` confia.

## Estrutura

```
src/
├── instrumentation.ts   # OpenTelemetry, carregado antes da aplicação
├── main.ts, app.module.ts, app.setup.ts
├── config/              # variáveis de ambiente validadas na subida
├── auth/                # validação do JWT, @Public(), @Roles(), @CurrentUser()
├── redis/               # conexões com redis-cache e redis-core, lock com token
├── cache/               # L1 em memória e métrica cache_requests_total
├── rate-limit/          # janela deslizante no redis-core e @RateLimited()
├── common/
│   ├── problem/         # Problem Details: exceção, filtro global e validação
│   ├── idempotency/     # Idempotency-Key no MongoDB (ADR 22)
│   ├── pagination/      # cursor
│   ├── ids/             # UUID v7
│   └── text/            # normalização para busca
├── venues/              # locais e setores
├── shows/               # shows, tabela de estados e regras de negócio
│   └── cache/           # cache da página e da busca
└── health/
test/                    # testes de integração (Testcontainers)
```

## Comandos

```bash
npm ci
npm test           # unitários: regras de domínio, sem banco
npm run test:e2e   # integração: aplicação inteira contra MongoDB e Redis reais (precisa de Docker)
npm run lint
npm run build
```

Para rodar fora do Compose, com a infraestrutura de pé (`make infra` na raiz):

```bash
MONGODB_URI=mongodb://localhost:27017/event_service \
REDIS_CACHE_URL=redis://localhost:6379 \
REDIS_CORE_URL=redis://localhost:6380 \
AUTH_ISSUER=http://localhost:8180/realms/lotou \
AUTH_JWKS_URI=http://localhost:8180/realms/lotou/protocol/openid-connect/certs \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
npm run build && npm run start:prod
```

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `3000` | porta HTTP |
| `MONGODB_URI` | — | conexão com o MongoDB |
| `REDIS_CACHE_URL` | — | conexão com o `redis-cache` (cache da página e da busca) |
| `REDIS_CORE_URL` | — | conexão com o `redis-core` (rate limit) |
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
