# payment-mock

Gateway de pagamento simulado. Node, NestJS 12, Postgres e Kafka.

Faz o papel do "banco" na saga de compra e de cancelamento: o order-service manda comandos em `payment.commands` e espera a resposta em `payment.events`, as duas com a chave `orderId`. O mock aprova ou recusa conforme uma taxa configurável, estorna ou falha o estorno, e demora como um gateway de verdade. Cada decisão fica gravada: o mesmo comando repetido recebe a mesma resposta e nunca cobra duas vezes.

Não tem API: além do health check, só conversa pelo Kafka.

## Mensagens

Os formatos estão em [`contracts/`](../../contracts/README.md).

| Recebe (`payment.commands`) | Responde (`payment.events`) |
| --- | --- |
| `AuthorizePayment` | `PaymentAuthorized` ou `PaymentDeclined` (motivo `INSUFFICIENT_FUNDS`, `CARD_DECLINED` ou `FRAUD_SUSPECTED`) |
| `RefundPayment` | `PaymentRefunded` ou `RefundFailed` (com `attempt`, a tentativa de estorno daquele pagamento) |

Cada resposta tem `eventId` novo (UUID v7). O `occurredAt` é a hora do fato (a aprovação, a recusa, o estorno), então uma resposta repetida descreve o mesmo fato com a mesma hora. Tipo ou versão que o serviço não conhece é ignorado, com log em debug.

## Comportamento

Um pagamento por pedido, na tabela `payments`, com estes estados:

| Estado | Significa | Pode ir para |
| --- | --- | --- |
| `AUTHORIZED` | aprovado | `REFUNDED` |
| `DECLINED` | recusado; nada foi cobrado | — |
| `REFUNDED` | aprovado e estornado | — |
| `VOIDED` | anulado: chegou um estorno de pedido que nunca foi autorizado | — |

A transição é conferida numa tabela única (`payment-status.ts`); o que está fora dela é recusado. Um estorno que falha não muda o estado, só conta mais uma tentativa.

**`AuthorizePayment`**

| Situação | Resposta |
| --- | --- |
| pedido sem pagamento | consulta o gateway: `PaymentAuthorized` ou `PaymentDeclined` (fração `DECLINE_RATE`) |
| pedido já aprovado ou estornado | `PaymentAuthorized` de novo, igual ao primeiro; o gateway não é consultado |
| pedido já recusado | `PaymentDeclined` de novo, com o mesmo motivo |
| pedido anulado (`VOIDED`) | `PaymentDeclined` com `CARD_DECLINED`: o pedido já foi cancelado e não pode ser cobrado |
| valor diferente do gravado | a resposta gravada, com o valor gravado, e um aviso no log |

**`RefundPayment`** (o estorno é sempre integral, como na regra de cancelamento)

| Situação | Resposta |
| --- | --- |
| pagamento aprovado | consulta o gateway: `PaymentRefunded` ou `RefundFailed` (fração `REFUND_FAILURE_RATE`) |
| pagamento já estornado | `PaymentRefunded` de novo, com o valor e a hora do estorno |
| pagamento recusado | `PaymentRefunded` com valor 0: nada foi cobrado, nada a devolver |
| pedido sem pagamento | grava o pedido como `VOIDED` e responde `PaymentRefunded` com valor 0 |
| pedido anulado | `PaymentRefunded` com valor 0 de novo |
| valor diferente do aprovado | estorna o aprovado e avisa no log |

Responder "estornado, valor 0" a quem não pagou deixa a saga de cancelamento terminar, em vez de esperar uma resposta que nunca viria. A linha `VOIDED` impede que um `AuthorizePayment` atrasado cobre um pedido que já foi cancelado.

O experimento de caos "payment-mock recusando 30%" (docs/projeto.md, "Caos") é `DECLINE_RATE=0.3`; o de estornos falhando é `REFUND_FAILURE_RATE` acima de 0.

## Idempotência e concorrência

Cada comando é processado numa transação que grava, juntos:

1. o `eventId` em `processed_events` (a mesma mensagem entregue de novo é reconhecida e ignorada, sem nova resposta);
2. o pagamento em `payments`, travado com `SELECT ... FOR UPDATE` (dois comandos do mesmo pedido nunca decidem ao mesmo tempo; `order_id` é único);
3. a resposta no `outbox`.

A consulta ao gateway, com a latência simulada, acontece antes da transação, para não segurar conexão nem lock enquanto o "banco" responde. Se outra instância decidir primeiro nesse meio-tempo, a decisão é descartada e o comando recomeça: ele encontra o pagamento gravado e repete a resposta. Um gateway real seria chamado com o pedido como chave de idempotência, então descartar a decisão não cobra nada.

Uma nova mensagem para o mesmo pedido (outro `eventId`) é uma nova pergunta e recebe uma nova resposta, com a decisão já gravada. É o que o order-service faz quando reenvia um comando sem resposta.

## Outbox e relay

O relay lê o `outbox` e publica no Kafka, a cada `OUTBOX_POLL_INTERVAL_MS` ou logo depois de um comando gravar uma resposta. Cada lote é uma transação: trava as linhas, envia, espera o `ack` do broker (produtor idempotente, `acks=all`) e marca `published_at`. Se o envio falha, as linhas ficam para a volta seguinte, com backoff de até 5 s. Se o processo cai entre o envio e a confirmação, a mensagem sai de novo com o mesmo `eventId`.

Mais de uma instância pode rodar o relay: `FOR UPDATE SKIP LOCKED` divide as linhas, e uma mensagem só sai se não houver outra anterior da mesma chave ainda pendente. Assim a ordem das respostas de um pedido se mantém mesmo com dois relays.

## Consumidor, novas tentativas e DLT

Consumer group `payment-mock`, entrega pelo menos uma vez: o offset só é guardado depois que o comando termina (com a resposta no outbox, ignorado ou na DLT). As partições são processadas em paralelo (`CONSUMER_CONCURRENCY`), cada uma em ordem.

| Falha | O que acontece |
| --- | --- |
| JSON inválido ou payload fora do contrato | vai direto para `payment.commands.dlt` |
| transição fora da tabela | vai direto para a DLT |
| falha passageira (Postgres fora, rede, deadlock) | tenta de novo com backoff (até 5 s), sem limite de tentativas e sem DLT; depois de 60 s na mesma entrega, a mensagem volta ao Kafka sem confirmar e é entregue de novo |
| outro erro | `CONSUMER_MAX_ATTEMPTS` tentativas com backoff exponencial a partir de `CONSUMER_RETRY_BACKOFF_MS`, e então a DLT |

A mensagem vai para a DLT com a mesma chave, o mesmo valor e os cabeçalhos originais, mais `dlt.original.topic`, `dlt.original.partition`, `dlt.original.offset`, `dlt.error.class`, `dlt.error.message`, `dlt.attempts` e `dlt.failed.at`. O offset da original só é confirmado depois do `ack` da DLT; o consumidor então segue para a próxima.

## Observabilidade

- **Traces:** o cliente do Kafka não tem auto-instrumentação, então os spans são feitos à mão. Cada comando gera um span `process payment.commands` (consumidor), filho do `traceparent` que veio no cabeçalho; as consultas ao Postgres ficam embaixo dele. O `traceparent` desse span é gravado na linha do outbox, e o relay cria o span `send payment.events` (produtor) como filho dele e o envia no cabeçalho da resposta: o trace do order-service atravessa o broker, passa por aqui e volta.
- **Métricas:** `payments_total{result}` conta as decisões do gateway (`authorized`, `declined`, `refunded`, `refund_failed`); respostas repetidas não contam. `kafka_dlt_messages_total{topic}` conta as mensagens enviadas para a DLT.
- **Logs:** JSON (pino) com `trace_id` e `span_id`. As mensagens não têm CPF nem e-mail, e os logs só levam IDs.

## Decisões

- **`pg` com um executor de migrações pequeno** (`src/database/migrate.ts`), em vez de ORM ou query builder. São três tabelas e um punhado de consultas; o SQL escrito à mão é o que importa aqui (`FOR UPDATE`, `SKIP LOCKED`, `ON CONFLICT`) e fica à vista. O `pg` é o driver de referência do Node e já é auto-instrumentado pelo OpenTelemetry. As migrações são arquivos `NNNN_nome.sql`, aplicadas na subida numa transação só, com um advisory lock para duas instâncias não as aplicarem juntas.
- **`@confluentinc/kafka-javascript`** (o cliente oficial da Confluent, sobre o librdkafka), com a API compatível com o KafkaJS. Instala o binário já compilado para Alpine (musl), sem compilador na imagem.
- **Comandos validados com Zod** espelhando os schemas de `contracts/`, porque a imagem não leva a pasta. Os testes conferem que os exemplos do contrato passam e que toda resposta é válida no schema (Ajv).

## Estrutura

```
src/
├── instrumentation.ts   # OpenTelemetry, carregado antes da aplicação
├── main.ts, app.module.ts
├── config/              # variáveis de ambiente validadas na subida
├── database/            # pool, migrações (migrations/*.sql), transação, erros passageiros
├── kafka/               # cliente, produtor, tópicos e cabeçalhos de trace
├── messages/            # leitura dos comandos e montagem das respostas
├── payments/            # estados, regras (payment-plan.ts), gateway simulado, serviço e repositório
├── outbox/              # gravação no outbox e relay para o Kafka
├── consumer/            # consumidor, novas tentativas e DLT
└── health/
test/                    # testes de integração (Testcontainers) e apoio
```

## Comandos

```bash
npm ci
npm test           # unitários: regras, gateway, mensagens contra contracts/, novas tentativas
npm run test:e2e   # integração: aplicação inteira contra Postgres e Kafka reais (precisa de Docker)
npm run lint
npm run format:check
npm run build
```

Os testes de integração rodam um arquivo de cada vez, porque todos usam o mesmo consumer group. `TEST_LOGS=1` mostra os logs da aplicação.

Para rodar fora do Compose, com a infraestrutura de pé (`make infra` na raiz):

```bash
DATABASE_URL=postgres://payments@localhost:5432/payments \
DATABASE_PASSWORD=payments \
KAFKA_BROKERS=localhost:9094 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
npm run build && npm run start:prod
```

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `3002` | porta do health check |
| `DATABASE_URL` | — | conexão com o banco `payments` |
| `DATABASE_PASSWORD` | — | senha do banco, quando não está na URL (vale por cima da URL) |
| `DATABASE_POOL_MAX` | `10` | conexões no pool |
| `KAFKA_BROKERS` | `localhost:9094` | brokers, separados por vírgula |
| `DECLINE_RATE` | `0` | fração das autorizações recusadas (0 a 1) |
| `REFUND_FAILURE_RATE` | `0` | fração dos estornos que falham (0 a 1) |
| `LATENCY_MIN_MS` / `LATENCY_MAX_MS` | `20` / `100` | latência simulada do gateway, sorteada no intervalo |
| `CONSUMER_CONCURRENCY` | `3` | partições processadas em paralelo |
| `CONSUMER_MAX_ATTEMPTS` | `5` | tentativas antes da DLT (falhas passageiras não contam) |
| `CONSUMER_RETRY_BACKOFF_MS` | `200` | espera depois da primeira falha; dobra a cada tentativa, até 5 s |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | intervalo do relay quando não há aviso de mensagem nova |
| `OUTBOX_BATCH_SIZE` | `100` | mensagens por lote do relay |
| `LOG_LEVEL` | `info` | nível do log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | endereço do OTel Collector |

No Compose, `DECLINE_RATE` e `REFUND_FAILURE_RATE` vêm de `PAYMENT_MOCK_DECLINE_RATE` e `PAYMENT_MOCK_REFUND_FAILURE_RATE` (padrão 0).
