# analytics-service

Vendas, relatório financeiro e pedidos do painel do produtor. Python 3.13, FastAPI, aiokafka e MongoDB (PyMongo assíncrono).

Consome `shows.catalog`, `order.events` e `inventory.events` e mantém read models no MongoDB (banco `analytics`). Não é dono de dado nenhum: tudo aqui pode ser apagado e reconstruído a partir do Kafka, e o replay faz isso sem tirar o painel do ar ([ADR 30](../../docs/adr/0030-replay-dos-read-models.md)).

## Read models

| Coleção | Um documento por | Conteúdo | Vem de |
| --- | --- | --- | --- |
| `shows` | show | cópia do catálogo: título, artista, produtor, status, local e fuso, setores com capacidade e lotes. Fica a `version` mais alta | `ShowPublished`, `ShowUpdated` |
| `sales_by_sector` | show, setor e hora (UTC) | ingressos vendidos, receita em centavos, pedidos e a divisão por lote | `OrderConfirmed` |
| `producer_statements` | show | vendas brutas, pedidos criados, confirmados e cancelados (por motivo), ingressos vendidos e emitidos, descontos, reembolsos e taxa (0 até a fase 6), valor a receber e se o relatório é parcial | eventos do pedido e o status do show |
| `order_view` | pedido | estado, itens com setor, lote, cadeira e preço, ingressos emitidos, linha do tempo e o resumo do show (título, data e local) | eventos do pedido e o catálogo |
| `lot_timeline` | lote | quando abriu (com preço e quantidade) e quando esgotou, em ordem | `LotOpened`, `LotSoldOut` |

- **Valor a receber** = vendas brutas − descontos − reembolsos − taxa de serviço absorvida (`docs/projeto.md`, "Financeiro"). O relatório é parcial até o show ficar `FINISHED` no catálogo.
- **Ocupação** (vendidos / capacidade) é calculada na leitura, com a capacidade do catálogo, por setor e no total.
- `ReservationConfirmed` e `ReservationReleased` são lidos e ignorados de propósito: o pedido confirmado ou cancelado já traz a mesma informação, com o motivo.
- Dinheiro em centavos (inteiro de 64 bits no MongoDB); datas em UTC. O `buyerId` fica no `order_view`, mas não sai na API do produtor. CPF e e-mail não existem nos eventos.

Cada coleção tem o número da geração no nome (`order_view_g3`). Uma view com o nome sem sufixo (`order_view`) aponta sempre para a geração ativa, para quem lê o banco de fora (o producer-assistant, o mongosh).

## Idempotência e ordem

O Kafka entrega ao menos uma vez, e a ordem só é garantida por chave (pedido no `order.events`, show no catálogo e no inventory). As projeções não dependem de nenhuma das duas coisas:

- **Uma transação por lote de partição.** O efeito de cada mensagem e o `eventId` dela em `processed_events` são gravados juntos; o offset só é confirmado depois. Repetição encontra o `eventId` e não faz nada.
- **Show:** fica a versão mais alta; uma versão antiga republicada é ignorada.
- **Pedido:** o estado anda pela tabela de transições (`PENDING` → `CONFIRMED` ou `CANCELLED`). Um fato anterior que chega depois só completa o documento; uma transição fora da tabela é recusada e registrada em log.
- **Vendas e contadores** só somam quando o pedido entra no estado, então nem um `OrderConfirmed` repetido com outro `eventId` conta duas vezes.
- **Pedido antes do show:** o `order_view` nasce com `show: null` e é preenchido quando o show chega (e atualizado se o título, a data ou o local mudarem). A transação que cria o `order_view` e a do catálogo gravam o mesmo documento do relatório, então o MongoDB não deixa as duas passarem juntas com uma leitura velha.

O resultado é o mesmo em qualquer ordem de chegada; um teste aplica a mesma noite de vendas embaralhada, com repetições, e compara documento a documento.

**Falhas:** mensagem fora do contrato (JSON inválido, campo faltando) vai direto para `<tópico>.dlt`; erro ao aplicar tenta `CONSUMER_MAX_ATTEMPTS` vezes e depois vai para a DLT, e o consumidor segue. Falha de infraestrutura (MongoDB fora, eleição no replica set) nunca vai para a DLT: o consumidor espera e tenta de novo, e o lag sobe. A mensagem na DLT leva a original, com a mesma chave e os cabeçalhos `dlt.original.topic`, `dlt.original.partition`, `dlt.original.offset`, `dlt.consumer.group`, `dlt.error.class` e `dlt.error.message`. Tipo desconhecido, ou versão que o serviço não conhece, é ignorado.

O consumidor usa `isolation_level=read_committed`: o relay do outbox do event-service publica o catálogo em transações Kafka, e mensagens de transações abortadas não chegam aos read models.

## Replay

Reconstrói todos os read models do começo dos tópicos (`order.events` e `inventory.events` não têm prazo de retenção, e `shows.catalog` é compactado), sem parar a leitura:

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
| `GET` | `/v1/analytics/shows/{showId}/sales` | produtor dono do show | por setor: vendidos, capacidade, ocupação, receita, pedidos, lotes (vendas e linha do tempo) e série por hora (UTC); o mesmo no total |
| `GET` | `/v1/analytics/shows/{showId}/statement` | produtor dono do show | relatório financeiro do show |
| `GET` | `/v1/analytics/shows/{showId}/orders` | produtor dono do show | pedidos do show, do mais novo para o mais antigo, paginados por cursor (`limit` até 100, `cursor`, `status`) |
| `POST` | `/internal/v1/replay` | conta de serviço | começa um replay; 202 com `Location` |
| `GET` | `/internal/v1/replay/{generation}` | conta de serviço | situação do replay |
| `GET` | `/health/live`, `/health/ready` | público | vivo; pronto (MongoDB responde e o consumidor está rodando) |

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

## Observabilidade

OpenTelemetry configurado no código, antes do cliente do MongoDB e da aplicação (`analytics/telemetry.py`): spans HTTP (FastAPI, menos o health check), um span por comando do MongoDB e, para cada mensagem do Kafka, um span `<tópico> process` filho do trace de quem publicou (cabeçalho `traceparent`). Logs em JSON no console, com `trace_id` e `span_id`, e também por OTLP. Métricas: `analytics_events_total{topic, type, result, consumer}` (`applied`, `duplicate`, `ignored`, `dead_lettered`) e `analytics_batch_duration` por tópico. O lag por consumer group vem do exporter do Kafka.

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
└── api/                   # rotas, JWT, Problem Details, paginação e respostas
tests/
├── unit/                  # regras, contratos (exemplos e JSON Schema), JWT, respostas
└── integration/           # MongoDB e Kafka reais (Testcontainers), replay de ponta a ponta
```

## Comandos

```bash
uv sync
uv run pytest tests/unit          # unitários
uv run pytest tests/integration   # MongoDB (replica set) e Kafka reais; precisa de Docker
uv run ruff check && uv run ruff format --check
uv run mypy
```

Na raiz, `make test-analytics-service` roda tudo isso. Os testes de integração usam as imagens do Compose (`mongo:8.0`, `apache/kafka:4.2.0`) e conferem as mensagens montadas contra os JSON Schemas de `contracts/`.

Para rodar fora do Compose, com a infraestrutura de pé (`make infra` na raiz):

```bash
MONGODB_URI="mongodb://localhost:27017/analytics?directConnection=true" \
KAFKA_BROKERS=localhost:9094 \
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
| `AUTH_ISSUER` | — | emissor esperado no JWT (URL pública do realm) |
| `AUTH_JWKS_URI` | — | de onde baixar as chaves públicas do realm |
| `AUTH_AUDIENCE` | `lotou-api` | audiência esperada no JWT |
| `CONSUMER_BATCH_SIZE` | `500` | mensagens lidas por vez; cada lote de uma partição é uma transação |
| `CONSUMER_MAX_ATTEMPTS` | `5` | tentativas de uma mensagem que falha antes de ir para a DLT |
| `GENERATION_POLL_SECONDS` | `1` | de quanto em quanto tempo o supervisor confere a geração ativa |
| `RETIRED_GENERATION_GRACE_SECONDS` | `30` | quanto tempo a geração aposentada fica de pé depois da troca |
| `PROCESSED_EVENTS_TTL_DAYS` | `30` | por quanto tempo o `eventId` processado é guardado |
| `REPLAY_LEASE_SECONDS` | `60` | validade do lock do replay, renovado enquanto ele anda |
| `LOG_LEVEL` | `INFO` | nível do log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | endereço do OTel Collector |
| `OTEL_SDK_DISABLED` | `false` | desliga o OpenTelemetry (testes) |
