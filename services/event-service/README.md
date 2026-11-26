# event-service

Shows, locais, setores e busca. Node, NestJS 12 e MongoDB.

É o dono do catálogo: o produtor cadastra locais e shows, publica, e a loja busca e exibe. Preço e estoque de verdade ficam com o inventory-service (fase 1); aqui os lotes são a configuração que a página do show exibe.

## API

Atrás do gateway, as rotas ganham o prefixo `/api` (`/api/v1/shows`).

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/v1/shows` | público | busca por `artist`, `city`, `from` e `to`, paginada por cursor |
| `GET` | `/v1/shows/:id` | público | página do show; rascunho só para o dono |
| `POST` | `/v1/shows` | produtor | cria o show como `DRAFT` (exige `Idempotency-Key`) |
| `PATCH` | `/v1/shows/:id` | dono | altera os campos enviados; exige a `version` lida |
| `POST` | `/v1/shows/:id/publish` | dono | `DRAFT` → `PUBLISHED`; exige local, setor e lote |
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

## Estrutura

```
src/
├── instrumentation.ts   # OpenTelemetry, carregado antes da aplicação
├── main.ts, app.module.ts, app.setup.ts
├── config/              # variáveis de ambiente validadas na subida
├── auth/                # validação do JWT, @Public(), @Roles(), @CurrentUser()
├── common/
│   ├── problem/         # Problem Details: exceção, filtro global e validação
│   ├── idempotency/     # Idempotency-Key no MongoDB (ADR 22)
│   ├── pagination/      # cursor
│   ├── ids/             # UUID v7
│   └── text/            # normalização para busca
├── venues/              # locais e setores
├── shows/               # shows, tabela de estados e regras de negócio
└── health/
test/                    # testes de integração (Testcontainers)
```

## Comandos

```bash
npm ci
npm test           # unitários: regras de domínio, sem banco
npm run test:e2e   # integração: aplicação inteira contra um MongoDB real (precisa de Docker)
npm run lint
npm run build
```

Para rodar fora do Compose, com a infraestrutura de pé (`make infra` na raiz):

```bash
MONGODB_URI=mongodb://localhost:27017/event_service \
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
| `AUTH_ISSUER` | — | emissor esperado no JWT (URL pública do realm) |
| `AUTH_JWKS_URI` | — | de onde baixar as chaves públicas do realm |
| `AUTH_AUDIENCE` | `lotou-api` | audiência esperada no JWT |
| `LOG_LEVEL` | `info` | nível do log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | endereço do OTel Collector |
