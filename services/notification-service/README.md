# notification-service

PDF dos ingressos com QR code, e-mails do comprador e o PDF do relatório financeiro do produtor. Python 3.13, FastAPI, aiokafka, aio-pika (RabbitMQ), Redis e SMTP.

Consome `order.events` e transforma os fatos do pedido em tarefas no RabbitMQ, onde ficam o retry com espera, a prioridade, a divisão de carga entre workers e a DLQ ([ADR 2](../../docs/adr/0002-rabbitmq-para-ingressos-e-e-mails.md)). Não é dono de dado nenhum: o estado são as filas e as marcas de deduplicação no `redis-core`.

```mermaid
flowchart LR
    K[("order.events")] --> C["consumidor do Kafka"]
    C -- "TicketsIssued" --> R["tickets.render"]
    C -- "OrderCancelled, OrderRefunded" --> E["notifications.email"]
    R --> W["worker de PDF<br/>pool de processos"] --> E
    P["POST /v1/reports/statements"] -- "relatório do analytics" --> G["reports.generate"]
    G --> WR["worker de relatório<br/>pool de processos"] --> E
    E --> M["worker de e-mail"] --> S["SMTP (Mailpit)"]
    M -- "falhou" --> T["notifications.retry.10s / 1m / 5m"] -- "TTL" --> E
    M -- "4ª falha" --> D["notifications.email.dlq"]
    W -- "sem saída" --> RD["tickets.render.dlq"]
    WR -- "sem saída" --> GD["reports.generate.dlq"]
```

## O que faz

| Evento | O que acontece |
| --- | --- |
| `TicketsIssued` | tarefa `RenderTickets` em `tickets.render`; o worker busca o show no event-service, gera um PDF com uma página por ingresso e publica `SendEmail` (`email.ticket.issued`, prioridade 9) com o PDF em base64; o worker de e-mail envia com o PDF anexado |
| `OrderCancelled` | tarefa `SendEmail` (`email.order.cancelled`, prioridade 5); o e-mail explica o motivo (pagamento recusado, reserva expirada, conflito na emissão) e o valor |
| `OrderRefunded` | tarefa `SendEmail` (`email.refund.completed`, prioridade 5); o e-mail "reembolso concluído" traz o valor devolvido em reais (taxa incluída), o motivo (cancelamento pelo comprador ou show cancelado) e o show com a data no fuso dele |
| outros | ignorados |

**Relatório financeiro sob demanda.** O produtor pede `POST /v1/reports/statements` com `{showId}`. A API lê o relatório na hora, na rota interna do analytics (`GET /internal/v1/shows/{id}/statement`, com o token da conta de serviço), confere que o `producerId` é o `sub` do token (show de outro produtor é 404, como o que não existe), põe a tarefa `GenerateStatement` com o relatório em `reports` (`statement.pdf`) e responde 202 com o id do pedido de relatório. O worker de `reports.generate` gera o PDF no pool de processos e publica `SendEmail` (`email.report.statement`, prioridade 5) com o PDF anexado; o worker de e-mail busca o endereço do produtor no Keycloak pelo `producerId`, como faz com o comprador. O PDF tem uma página: o show (título, artista, data e local, no fuso do show), as linhas do relatório (vendas brutas, descontos de cupom, reembolsos, taxa absorvida e valor a receber), o que é informativo (taxa paga pelos compradores, pedidos e ingressos), se é parcial ou final, de quando são os dados e quando foi gerado, no fuso do show.

O consumidor do Kafka só confirma o offset depois que o RabbitMQ confirmou a tarefa (publisher confirms), e cada worker só dá ack depois de publicar o passo seguinte. Com o serviço fora do ar, os eventos esperam no Kafka e as tarefas esperam nas filas, duráveis.

**O ingresso:** uma página A4 por ingresso, com título do show, artista, data e hora **no fuso do local do show**, local, setor, lugar (a cadeira ou `Pista`), o id do ingresso e o QR code do `code` que o order-service assinou (ADR 15; aqui ele só é desenhado). O QR é desenhado em vetor, um retângulo por trecho de módulos escuros, com correção de erro M e margem de 4 módulos: nítido em qualquer impressão e poucos KB por página.

- **`segno`** gera a matriz do QR code: Python puro, sem dependência, e segue a norma (ISO/IEC 18004).
- **`fpdf2`** monta o PDF: Python puro, rápido (milissegundos por página), sem navegador nem LaTeX. As fontes padrão do PDF cobrem o Latin-1, que tem todo o português; caracteres fora dele (travessão, aspas curvas, emoji num título) são trocados por um equivalente ou retirados.

**O e-mail:** texto simples e HTML simples, em português, com o nome do comprador. O `Message-ID` sai do `eventId`, então um leitor que receber o mesmo e-mail duas vezes os junta.

## Topologia do RabbitMQ

Declarada pelo serviço ao subir, de forma idempotente; a conexão robusta declara de novo depois de uma reconexão.

| Exchange | Tipo | Routing key | Fila | Argumentos | Consumo |
| --- | --- | --- | --- | --- | --- |
| `tickets` | direct | `render` | `tickets.render` | DLX `tickets.dlx` | `RENDER_WORKERS` consumidores, prefetch 1 |
| `tickets.dlx` | fanout | | `tickets.render.dlq` | | inspeção e requeue |
| `notifications` | topic | `email.#` | `notifications.email` | `x-max-priority` 10, DLX `notifications.dlx` | prefetch `EMAIL_PREFETCH` (10), ack manual |
| `notifications.retry` | direct | `10s`, `1m`, `5m` | `notifications.retry.10s`, `.1m`, `.5m` | `x-message-ttl`, DLX `notifications` | ninguém: a mensagem volta sozinha |
| `notifications.dlx` | fanout | | `notifications.email.dlq` | | inspeção e requeue |
| `reports` | direct | `statement.pdf` | `reports.generate` | DLX `reports.dlx` | um consumidor, prefetch 1 |
| `reports.dlx` | fanout | | `reports.generate.dlq` | | inspeção e requeue |

Filas clássicas e duráveis, mensagens persistentes. O PDF (do ingresso e do relatório) é trabalho de CPU: cada consumidor de `tickets.render` manda o PDF para um processo do pool (criado com `spawn`), e o event loop segue atendendo o Kafka, os e-mails e o health check. Para mais vazão, aumente `RENDER_WORKERS` ou suba mais instâncias.

## Retry e DLQ

O número da tentativa viaja no cabeçalho `x-attempt` (1 na primeira entrega). Se o envio falha (SMTP, Keycloak ou event-service fora, ou um erro inesperado):

| Tentativa que falhou | Próximo passo |
| --- | --- |
| 1 | `notifications.retry` com a chave `10s`; volta em 10 s com `x-attempt: 2` |
| 2 | chave `1m`, `x-attempt: 3` |
| 3 | chave `5m`, `x-attempt: 4` |
| 4 | `notifications.dlx` → `notifications.email.dlq` |

A mensagem é republicada com a chave da espera e, no cabeçalho `CC`, a chave do template; a fila de retry não tem routing key de dead-letter, então, ao vencer o TTL, a mensagem volta a `notifications` com as duas chaves, e só a do template casa com `email.#`. A original só recebe ack depois que o broker confirmou a republicação.

Na DLQ, a mensagem leva `x-attempt` (as tentativas feitas), `x-error` (o motivo, sem endereço de e-mail), `x-failed-at` e `x-original-queue`. Vai direto para a DLQ, sem retry, o que repetir não resolve: tarefa ilegível e, no PDF, show que o event-service não conhece. O mesmo vale para `reports.generate`: tarefa ilegível ou erro ao gerar o PDF do relatório vai para `reports.generate.dlq`. Com o event-service fora do ar, o worker de PDF segura a tarefa e tenta de novo com espera crescente (até 30 s), sem DLQ: os outros PDFs esperam na fila.

Comprador sem e-mail (as contas de serviço do smoke e dos testes de carga) é confirmado e contado em `emails_sent_total{result="no_recipient"}`, sem retry.

**Requeue:** depois de corrigir a causa, as mensagens voltam ao exchange de origem com `x-attempt: 1`, para uma nova rodada de 4 tentativas. O requeue tira só o que havia na DLQ no começo (não entra em laço com uma mensagem que falhe de novo) e só remove cada uma da DLQ depois que o broker confirmou a republicação.

```bash
make requeue-notifications                    # na raiz, com o ambiente no ar: as três DLQs
docker compose exec notification-service python -m notification.dlq depth
docker compose exec notification-service python -m notification.dlq requeue --queue email --limit 100
```

Ou `POST /internal/v1/dlq/requeue` com o token de uma conta de serviço (corpo opcional `{"queue": "notifications.email.dlq", "limit": 100}`; também `tickets.render.dlq` e `reports.generate.dlq`) e `GET /internal/v1/dlq` para ver quantas mensagens há em cada DLQ. A linha de comando sai com 0 (concluído), 1 (falhou) ou 2 (alguma mensagem ilegível ficou na DLQ).

## Sem e-mail repetido

O Kafka entrega ao menos uma vez, e um worker pode cair entre publicar o passo seguinte e dar ack. Duas marcas no `redis-core`, pelo `eventId` do Kafka (nunca e-mail ou CPF na chave):

- `notification:event:{eventId}`: o evento já virou tarefa. Gravada depois da confirmação do RabbitMQ; uma reentrega do Kafka é ignorada.
- `notification:email:{eventId}`: reserva (`SET NX` com `sending:<messageId>`) antes de enviar e `sent` depois. Duas cópias da mesma tarefa tratadas ao mesmo tempo mandam um e-mail só; uma falha solta a reserva para a próxima tentativa.

As duas vencem em 7 dias (`DEDUPE_TTL_SECONDS`). Com o Redis fora, o serviço segue sem deduplicação e conta em `notification_dedupe_unavailable_total`: um e-mail repetido é melhor que um ingresso que não chega.

## De onde vem o e-mail do comprador

Os eventos só levam o `buyerId` (o `sub` do token). O worker de e-mail consulta `GET /admin/realms/lotou/users/{buyerId}` no Keycloak com a conta de serviço `notification-service` (client credentials), que tem só o papel `view-users` do cliente `realm-management` e o escopo `kc-admin-api`, que põe no token a audiência exigida pela API de administração (`infra/keycloak/lotou-realm.json`). O token fica em memória até perto de vencer, e a consulta por 5 minutos (`BUYER_CACHE_SECONDS`). O e-mail do relatório vai para o produtor, buscado do mesmo jeito pelo `producerId`.

O mesmo token chama o analytics: a conta de serviço também tem o papel de realm `service` e o escopo `lotou-api` (audiência `lotou-api`), que a rota interna do relatório exige. Um token só, guardado uma vez (`clients/service_token.py`), serve as duas APIs.

O endereço só existe na memória do worker: não vai para log, span, métrica, cabeçalho nem chave do Redis. O span do SMTP leva o template e o tamanho, não o destinatário, e a mensagem de erro de um servidor SMTP passa por um filtro que tira endereços antes de ir para o log ou para a DLQ.

## API

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `POST` | `/v1/reports/statements` | produtor dono do show | `{showId}` → `202` com `{requestId, showId, status: "QUEUED", requestedAt}`; o PDF do relatório chega por e-mail |
| `POST` | `/internal/v1/dlq/requeue` | conta de serviço | devolve uma DLQ para a fila; responde `{"queue", "requeued", "skipped"}` |
| `GET` | `/internal/v1/dlq` | conta de serviço | mensagens em cada DLQ |
| `GET` | `/health/live`, `/health/ready` | público | vivo; pronto (RabbitMQ conectado e consumidor do Kafka rodando; o Redis aparece, mas não derruba) |

Atrás do gateway, `/v1/reports/**` ganha o prefixo `/api` e exige o papel `producer`; as rotas `/internal` não têm rota no gateway e exigem o papel `service`. O token é validado aqui (ADR 21): assinatura pelo JWKS do realm, emissor, audiência `lotou-api` e validade. Erros em Problem Details (RFC 9457): `validation-error` (400, `showId` que não é UUID), `unauthorized` (401), `forbidden` (403), `not-found` (404, show que não existe ou de outro produtor) e `service-unavailable` (503, analytics, Keycloak ou RabbitMQ fora).

O pedido de relatório e o requeue não criam recurso, então não exigem `Idempotency-Key`. No relatório ela é aceita: com ela, o id do pedido de relatório sai da chave (e do produtor), e repetir o pedido manda um e-mail só, pela mesma marca de deduplicação dos outros e-mails. No requeue, repetir só devolve o que tiver chegado à DLQ depois.

## Observabilidade

OpenTelemetry configurado no código (`notification/telemetry.py`), com `service.name=notification-service`:

- **Kafka:** um span `order.events process` por mensagem, filho do `traceparent` que o relay do outbox do order-service pôs no cabeçalho.
- **RabbitMQ:** instrumentação do aio-pika, um span por publicação e por mensagem consumida, com o `traceparent` nos cabeçalhos AMQP. Uma retentativa é filha da tentativa que falhou: o trace mostra o caminho inteiro, do order-service ao SMTP.
- **HTTP:** FastAPI (menos o health check) e httpx (event-service, analytics e Keycloak). **PDF do relatório:** span `statement render`. **Redis:** comandos com os argumentos trocados por `?`. **PDF e SMTP:** spans `ticket render` e `smtp send`.
- Logs em JSON no console, com `trace_id` e `span_id`, e também por OTLP.

| Métrica | Tipo | O que mede |
| --- | --- | --- |
| `ticket_render_duration_seconds{result}` | histograma | tempo para gerar o PDF de um pedido |
| `statement_render_duration_seconds{result}` | histograma | tempo para gerar o PDF do relatório financeiro de um show |
| `statements_rendered_total{result}` | contador | `rendered`, `dead_lettered` |
| `notifications_dlq_depth{queue}` | gauge | mensagens em `notifications.email.dlq`, `tickets.render.dlq` e `reports.generate.dlq`, lidas a cada `DLQ_POLL_SECONDS`; o alerta "DLQ" é qualquer valor acima de zero |
| `emails_sent_total{template, result}` | contador | `sent`, `retried`, `dead_lettered`, `no_recipient`, `duplicate`, `invalid` |
| `tickets_rendered_total{result}` | contador | `rendered`, `dead_lettered` |
| `notification_events_total{type, result}` | contador | eventos lidos do Kafka: `queued`, `duplicate`, `ignored`, `dead_lettered` |

## Estrutura

```
src/notification/
├── __main__.py            # python -m notification: API, consumidor do Kafka e workers
├── config.py              # variáveis de ambiente validadas na subida
├── telemetry.py           # OpenTelemetry e logs em JSON
├── contracts.py           # leitura de order.events (contracts/ na raiz)
├── tasks.py               # tarefas do RabbitMQ: RenderTickets e SendEmail
├── service.py             # monta conexões, topologia, consumidor e workers
├── kafka/                 # consumidor de order.events e DLT
├── rabbit/                # topologia, publicação com confirmação, retry, DLQ e consumidor de fila
├── workers/               # worker de PDF, de relatório e de e-mail
├── render/                # PDF do ingresso e do relatório, QR code, textos no fuso do show e o pool de processos
├── mail/                  # e-mails (texto e HTML) e envio por SMTP
├── clients/               # event-service (show), analytics (relatório), Keycloak (comprador e token da conta de serviço)
├── dedupe.py              # marcas de deduplicação no Redis
├── dlq/                   # profundidade, requeue e a linha de comando
└── api/                   # pedido de relatório, rotas internas, JWT e Problem Details
tests/
├── unit/                  # PDF e QR (lido de volta da página), fuso, retry, contratos, e-mails, clientes, JWT
└── integration/           # Kafka, RabbitMQ, Redis, Mailpit e Keycloak reais (Testcontainers)
```

## Testes

Os de integração sobem Kafka, RabbitMQ, Redis e Mailpit reais, com as imagens do Compose; o event-service, o analytics e a API do Keycloak são fakes HTTP, e um teste à parte sobe o Keycloak com o realm do repositório e confere a conta de serviço de verdade. As esperas de retry ficam em 0,4 s.

- **PDF:** cada página é rasterizada com o pdfium e o QR code é lido da imagem com o zxing-cpp (só nos testes), então o teste prova que o que foi impresso decodifica para o `code` do ingresso.
- **Ponta a ponta:** `TicketsIssued` no Kafka vira e-mail no Mailpit com o PDF anexado, num trace só; evento repetido, ou tarefa repetida, manda um e-mail só; o e-mail do ingresso fura a fila acumulada.
- **DLQ demonstrada (critério da fase 4):** com o SMTP numa porta fechada, o e-mail passa pelas 4 tentativas e cai em `notifications.email.dlq`, com o motivo; `notifications_dlq_depth` mostra 1; o requeue pela API, com o SMTP de volta, entrega o e-mail e a métrica volta a 0.
- **Caos:** serviço parado enquanto os eventos chegam, e worker de e-mail parado com a fila enchendo; ao voltar, todos os e-mails saem.
- **Fase 6:** `OrderRefunded` vira o e-mail de reembolso no Mailpit, com o valor e a data no fuso do show; o relatório pedido pelo dono chega como PDF anexado, e o texto do PDF lido de volta tem o valor a receber; outro produtor recebe 404 e nada é enfileirado; a mesma `Idempotency-Key` manda um e-mail só; tarefa ilegível em `reports.generate` cai na DLQ dela e o requeue a devolve. O teste do realm confere, num Keycloak de verdade, que o token da conta de serviço tem o papel `service` e a audiência `lotou-api` e continua só lendo usuários.

## Comandos

```bash
uv sync
uv run pytest tests/unit          # unitários
uv run pytest tests/integration   # Kafka, RabbitMQ, Redis, Mailpit e Keycloak reais; precisa de Docker
uv run ruff check && uv run ruff format --check
uv run mypy
```

Na raiz, `make test-notification-service` roda tudo isso. Os e-mails enviados no ambiente local aparecem em http://localhost:8025 (Mailpit), e as filas em http://localhost:15672 (RabbitMQ, `lotou` / `lotou`).

Para rodar fora do Compose, com a infraestrutura de pé (`make infra` na raiz) e o event-service e o analytics no ar:

```bash
RABBITMQ_URL=amqp://lotou:lotou@localhost:5672/ \
KAFKA_BROKERS=localhost:9094 \
REDIS_URL=redis://localhost:6380 \
SMTP_HOST=localhost SMTP_PORT=1025 \
EVENT_SERVICE_URL=http://localhost:3000 \
ANALYTICS_SERVICE_URL=http://localhost:8084 \
KEYCLOAK_URL=http://localhost:8180 \
KEYCLOAK_CLIENT_SECRET=notification-service-dev-secret \
AUTH_ISSUER=http://localhost:8180/realms/lotou \
AUTH_JWKS_URI=http://localhost:8180/realms/lotou/protocol/openid-connect/certs \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
uv run python -m notification
```

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `8085` | porta HTTP |
| `KAFKA_BROKERS` | `localhost:9094` | endereço do Kafka |
| `KAFKA_GROUP_ID` | `notification-service` | consumer group de `order.events` |
| `KAFKA_AUTO_OFFSET_RESET` | `latest` | de onde um consumer group novo começa; `order.events` não tem prazo, e `earliest` mandaria e-mail de todo o histórico |
| `CONSUMER_BATCH_SIZE` | `100` | mensagens lidas do Kafka por vez |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672/` | conexão com o RabbitMQ |
| `RENDER_WORKERS` | `2` | consumidores de `tickets.render` e processos que geram PDFs |
| `EMAIL_PREFETCH` | `10` | e-mails em andamento ao mesmo tempo |
| `RETRY_DELAYS_SECONDS` | `10,60,300` | esperas das filas `notifications.retry.10s`, `.1m` e `.5m`; mudar num ambiente que já tem as filas exige apagá-las |
| `DLQ_POLL_SECONDS` | `15` | de quanto em quanto tempo a profundidade das DLQs é lida para a métrica |
| `REDIS_URL` | `redis://localhost:6380` | `redis-core`, para a deduplicação |
| `DEDUPE_TTL_SECONDS` | `604800` | por quanto tempo as marcas de deduplicação ficam (7 dias) |
| `EVENT_SERVICE_URL` | `http://localhost:3000` | de onde vem o show (`GET /v1/shows/{id}`) |
| `ANALYTICS_SERVICE_URL` | `http://localhost:8084` | de onde vem o relatório financeiro (`GET /internal/v1/shows/{id}/statement`) |
| `SHOW_CACHE_SECONDS` | `60` | quanto tempo o show fica em memória |
| `KEYCLOAK_URL` | `http://localhost:8180` | Keycloak, para o token da conta de serviço e a API de administração |
| `KEYCLOAK_REALM` | `lotou` | realm dos compradores |
| `KEYCLOAK_CLIENT_ID` | `notification-service` | cliente da conta de serviço |
| `KEYCLOAK_CLIENT_SECRET` | — | segredo do cliente |
| `BUYER_CACHE_SECONDS` | `300` | quanto tempo o e-mail e o nome do comprador ficam em memória |
| `SMTP_HOST`, `SMTP_PORT` | `localhost`, `1025` | servidor SMTP (Mailpit em desenvolvimento) |
| `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_START_TLS` | vazio, vazio, `false` | autenticação e STARTTLS, para um SMTP de verdade |
| `SMTP_TIMEOUT_SECONDS` | `10` | prazo de um envio |
| `MAIL_FROM` | `Lotou <ingressos@lotou.test>` | remetente |
| `AUTH_ISSUER` | — | emissor esperado no JWT (URL pública do realm) |
| `AUTH_JWKS_URI` | — | de onde baixar as chaves públicas do realm |
| `AUTH_AUDIENCE` | `lotou-api` | audiência esperada no JWT |
| `LOG_LEVEL` | `INFO` | nível do log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | endereço do OTel Collector |
| `OTEL_SDK_DISABLED` | `false` | desliga o OpenTelemetry |
