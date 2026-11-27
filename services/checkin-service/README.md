# checkin-service

Portaria do show. Node, NestJS 12, Postgres, Redis (`redis-core`) e Kafka.

Lê o QR code dos ingressos no portão e decide, em poucos milissegundos, se a pessoa entra. Cada ingresso libera uma única entrada; o leitor mostra três resultados: liberado (verde), já utilizado com horário e portão (amarelo) e inválido ou cancelado (vermelho).

A portaria não pergunta nada ao order-service na hora da leitura: ela tem uma cópia local dos ingressos e dos shows, alimentada pelo Kafka (ADR 14). Com o order-service fora do ar no dia do show, ela continua validando.

## Cópia local

| Consome | Mensagem | Efeito |
| --- | --- | --- |
| `order.events` | `TicketsIssued` | grava os ingressos em `valid_tickets` como `VALID` (pedido, show, setor, cadeira) |
| `order.events` | `TicketsCancelled` | marca os ingressos `CANCELLED`, com o motivo; a linha fica, para o leitor dizer "cancelado" |
| `order.events` | os outros fatos do pedido | ignorados, sem olhar o payload |
| `shows.catalog` | `ShowPublished`, `ShowUpdated` | grava em `shows` o que a portaria usa: título, artista, início, abertura dos portões, local, fuso, produtor e status; fica a versão mais alta |

Os formatos estão em [`contracts/`](../../contracts/README.md). O consumidor usa o grupo `checkin-service`, lê os dois tópicos desde o começo (a portaria precisa de todo ingresso já emitido) e só o que foi confirmado (`read_committed`).

Os ingressos são aplicados numa transação com o `eventId` em `processed_events`: a mesma mensagem entregue de novo não muda nada. Um ingresso que já está na cópia não é sobrescrito, então nem um `TicketsIssued` atrasado ressuscita um ingresso cancelado. O show usa a própria versão como chave de idempotência.

Estados do ingresso (`ticket-status.ts`), conferidos numa tabela única:

| Estado | Significa | Pode ir para |
| --- | --- | --- |
| `VALID` | emitido, ainda não usado | `USED`, `CANCELLED` |
| `USED` | entrou no show | — |
| `CANCELLED` | pedido cancelado ou show cancelado | — |

Um `TicketsCancelled` que inclui um ingresso já usado (o cancelamento cruzou com a entrada) cancela os outros e deixa esse como `USED`, com um aviso no log.

| Falha no consumidor | O que acontece |
| --- | --- |
| JSON inválido ou payload fora do contrato (inclusive fuso horário desconhecido) | vai direto para `<tópico>.dlt` |
| falha passageira (Postgres fora, rede, deadlock) | tenta de novo com backoff, sem DLT; depois de 60 s, a mensagem volta ao Kafka sem confirmar |
| outro erro | `CONSUMER_MAX_ATTEMPTS` tentativas e DLT |

## Leitura do QR

`POST /v1/checkins` com `{showId, gate, code}`:

1. **Assinatura, sem banco.** O código é `LOTOU1.<ticketId>.<assinatura>`, com a assinatura HMAC-SHA256 em base64url (ADR 15). A portaria confere com a mesma chave do order-service (`TICKET_QR_KEY`), em tempo constante (`timingSafeEqual`). Falsificado ou malformado é `INVALID_CODE` sem nenhuma consulta ao Postgres.
2. **Uma consulta pela chave primária** traz o ingresso, o horário do show e a entrada, se já houver.
3. **Regras, nesta ordem:** desconhecido, de outro show, cancelado, já usado, antes da abertura dos portões. Sem `doorsOpenAt`, os portões abrem no começo do dia do show no fuso do local (nunca na véspera, mesmo quando em UTC já é outro dia). Sem o show na cópia local, a abertura não é conferida: barrar um ingresso válido porque o catálogo atrasou é pior.
4. **Corrida entre portões.** Ver abaixo.
5. **Entrada gravada:** a linha em `checkins`, o ingresso em `USED` e o `TicketCheckedIn` no outbox, numa transação.

### Dois portões com o mesmo QR

O caso é um print do ingresso passado adiante: duas pessoas, dois portões, o mesmo segundo.

- **Caminho rápido: `SET NX` no Redis.** `checkin:{ticketId}` no `redis-core`, com `{at, gate}` no valor e validade até um dia depois do início do show. Quem consegue o `SET` grava a entrada; os outros leem o valor e respondem `ALREADY_USED` com o horário e o portão do primeiro, sem esperar o banco.
- **Palavra final: a constraint única.** `checkins.ticket_id` é único, e a entrada é gravada com `INSERT ... ON CONFLICT DO NOTHING`. Com o Redis fora, lento (o comando tem 150 ms de teto) ou sem os dados, a leitura vai direto ao banco: as transações concorrentes esperam a primeira, e só ela grava. As outras leem a entrada dela e respondem `ALREADY_USED`.
- **Redis sem os dados:** a cópia local já diz `USED`, e a leitura responde `ALREADY_USED` antes de chegar ao Redis.
- **Marca sem entrada:** se quem marcou o Redis falha ao gravar (o ingresso foi cancelado no meio-tempo, ou o banco caiu), a marca é desfeita (só se ainda for a dele). Se o processo cai entre o Redis e o banco, a marca fica; uma marca com mais de 5 s de um ingresso que o banco diz `VALID` é velha e não vale mais.

Os testes de integração disparam dez leituras do mesmo QR ao mesmo tempo, todas já com o ingresso lido como `VALID`: uma entrada, nove `ALREADY_USED` e uma linha em `checkins`, com o Redis no ar e com ele fora.

### Recusas

Toda leitura recusada vira um `CheckinRejected`. As recusas vão para o banco em lote, a cada `REJECTION_FLUSH_INTERVAL_MS`: a linha em `checkin_rejections` (para o resumo) e o evento no outbox, numa transação. É o que deixa o QR falsificado ser recusado sem tocar no banco, e um portão sob uma enxurrada de códigos falsos não abre uma transação por leitura. Se o processo cair, as recusas do último intervalo se perdem; uma recusa não muda estado nenhum. Com o banco fora por muito tempo, a fila em memória guarda até 20 mil recusas e descarta as mais antigas (`checkin_rejections_dropped_total`).

## API

Todas as rotas exigem o JWT do Keycloak, validado de novo aqui (ADR 21): audiência `lotou-api`, papéis em `realm_access.roles`. Pelo gateway, o prefixo é `/api`.

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `POST` | `/v1/checkins` | `gate-staff` | `{showId, gate, code}` → sempre `200` com `{result, ticket, firstEntry}` |
| `GET` | `/v1/checkins/shows` | `gate-staff` | shows de hoje e dos próximos `SHOWS_DAYS_AHEAD` dias, em ordem de início, paginados por cursor: `{items: [{showId, title, artist, startsAt, timezone, doorsOpenAt, venueName}], nextCursor}` |
| `GET` | `/v1/checkins/shows/{showId}/summary` | `gate-staff`, ou `producer` dono do show | `{checkedIn, byGate: [{gate, count}], rejected}` |

"Hoje" é o dia no fuso de cada show; um show que começou há menos de 12 horas continua na lista (a portaria segue aberta depois da meia-noite). Shows cancelados ficam de fora. Para um produtor que não é o dono, o resumo responde `404`, como se o show não existisse.

O `POST` só responde `400` (Problem Details, `urn:lotou:problem:validation-error`) para um corpo malformado: `showId` que não é UUID, portão vazio, com mais de 40 caracteres ou com caractere de controle (ele vira rótulo de métrica), código vazio ou com mais de 4 KB. Um código qualquer, mesmo um QR de outro sistema, é uma leitura válida: `200` com `INVALID_CODE`. Espaços e quebra de linha em volta do código são ignorados (leitores que funcionam como teclado mandam um Enter no fim).

### Resultados

| `result` | Cor | Quando | `ticket` | `firstEntry` |
| --- | --- | --- | --- | --- |
| `ACCEPTED` | verde | primeira leitura de um ingresso válido deste show, com os portões abertos | sim | `null` |
| `ALREADY_USED` | amarelo | o ingresso já entrou, por este ou outro portão | sim | `{at, gate}` da entrada |
| `INVALID_CODE` | vermelho | código malformado ou assinatura que não confere | `null` | `null` |
| `UNKNOWN_TICKET` | vermelho | assinatura válida, mas o ingresso não está na cópia local | `null` | `null` |
| `CANCELLED` | vermelho | pedido cancelado ou reembolsado, ou show cancelado | sim | `null` |
| `WRONG_SHOW` | vermelho | ingresso de outro show | sim | `null` |
| `NOT_OPEN` | vermelho | antes da abertura dos portões | sim | `null` |

`ticket` é `{ticketId, sectorName, seat}` (`seat` nulo na pista); `firstEntry.at` vem em UTC, e o leitor o mostra no fuso do show.

## Eventos publicados

`checkin.events`, chave `showId`, pelo outbox (ADR 8): `TicketCheckedIn` na entrada e `CheckinRejected` (com o motivo e o `ticketId`, nulo em `INVALID_CODE`) na recusa. O relay publica um lote por vez, sob um advisory lock: num show lotado, todas as entradas têm a mesma chave, e o lote leva várias delas, na ordem. O `traceparent` da leitura é gravado com o evento e segue no cabeçalho da mensagem.

## Observabilidade

- **Traces:** HTTP, Postgres e Redis pela auto-instrumentação. O Kafka não tem auto-instrumentação: cada mensagem consumida gera um span `process <tópico>` filho do `traceparent` recebido, e cada evento publicado um span `send checkin.events` filho do trace da leitura. A leitura marca no span o show, o portão, o ingresso (quando o código é válido), o resultado, a cor e o que o Redis respondeu (`claimed`, `taken`, `stale`, `unavailable`).
- **Métricas:** `checkins_total{gate, result}` (painel "Portaria ao vivo": entradas por minuto e por portão, leituras recusadas), `checkin_duration_seconds{result}` (histograma da leitura, para a meta de p99 abaixo de 200 ms), `checkin_rejections_dropped_total` e `kafka_dlt_messages_total{topic}`.
- **Logs:** JSON (pino) com `trace_id` e `span_id`. O código do QR nunca vai para log nem para span (ele é o ingresso); quando a assinatura confere, o log leva só o `ticketId`. O log de requisição tem só método, rota e status, sem corpo nem cabeçalhos.

## Decisões

- **Copiado do payment-mock:** `pg` com um executor de migrações pequeno, `@confluentinc/kafka-javascript` com spans manuais, outbox com relay e DLT. Do event-service: validação do JWT com `jose` e erros em Problem Details.
- **Cópia local em vez de consulta ao order-service, HMAC antes do banco, Redis com a constraint única como palavra final:** ADR 14.
- **`/health/ready` só olha o Postgres:** a leitura funciona sem o Kafka (as entradas esperam no outbox) e sem o Redis (a constraint decide). Tirar a portaria do ar por causa deles pararia a fila na porta sem motivo.

## Estrutura

```
src/
├── instrumentation.ts   # OpenTelemetry, carregado antes da aplicação
├── main.ts, app.module.ts, app.setup.ts
├── auth/                # validação do JWT e papéis
├── checkin/             # leitura do QR: assinatura, regras, Redis, gravação, recusas, API
├── tickets/             # cópia local: estados do ingresso e aplicação das mensagens
├── messages/            # leitura do que chega e montagem do que sai
├── consumer/            # consumidor, novas tentativas e DLT
├── outbox/              # gravação no outbox e relay para o Kafka
├── config/, common/, database/, kafka/, redis/, health/, telemetry/
test/                    # testes de integração (Testcontainers) e apoio
```

## Comandos

```bash
npm ci
npm test           # unitários: HMAC, regras, abertura dos portões com fusos, mensagens contra contracts/
npm run test:e2e   # integração: aplicação inteira contra Postgres, Redis e Kafka reais (precisa de Docker)
npm run lint
npm run format:check
npm run build
```

Os testes de integração rodam um arquivo de cada vez, porque todos usam o mesmo consumer group. Eles cobrem a corrida entre dez portões (com e sem Redis), o código falsificado sem consulta ao banco, o cancelamento, a mensagem repetida e a latência: 200 leituras seguidas pela API, com o p99 escrito na saída (entre 15 e 40 ms na máquina de desenvolvimento, dividida com outros testes; a asserção aceita até 600 ms). `TEST_LOGS=1` mostra os logs da aplicação.

Para rodar fora do Compose, com a infraestrutura de pé (`make infra` na raiz):

```bash
DATABASE_URL=postgres://checkin@localhost:5432/checkin \
DATABASE_PASSWORD=checkin \
REDIS_URL=redis://localhost:6380 \
KAFKA_BROKERS=localhost:9094 \
TICKET_QR_KEY=lotou-dev-ticket-qr-key \
AUTH_ISSUER=http://localhost:8180/realms/lotou \
AUTH_JWKS_URI=http://localhost:8180/realms/lotou/protocol/openid-connect/certs \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
npm run build && npm run start:prod
```

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `3003` | porta HTTP |
| `DATABASE_URL` | — | conexão com o banco `checkin` |
| `DATABASE_PASSWORD` | — | senha do banco, quando não está na URL (vale por cima da URL) |
| `DATABASE_POOL_MAX` | `20` | conexões no pool |
| `REDIS_URL` | — | `redis-core`, onde fica `checkin:{ticketId}` |
| `KAFKA_BROKERS` | `localhost:9094` | brokers, separados por vírgula |
| `TICKET_QR_KEY` | — | chave do HMAC do QR, a mesma do order-service (pelo menos 16 caracteres) |
| `AUTH_ISSUER` | — | emissor esperado no JWT (URL pública do realm) |
| `AUTH_JWKS_URI` | — | de onde baixar as chaves públicas do realm |
| `AUTH_AUDIENCE` | `lotou-api` | audiência exigida no JWT |
| `SHOWS_DAYS_AHEAD` | `7` | quantos dias à frente a lista de shows mostra |
| `REJECTION_FLUSH_INTERVAL_MS` | `200` | intervalo da gravação das recusas em lote |
| `CONSUMER_CONCURRENCY` | `3` | partições processadas em paralelo |
| `CONSUMER_MAX_ATTEMPTS` | `5` | tentativas antes da DLT (falhas passageiras não contam) |
| `CONSUMER_RETRY_BACKOFF_MS` | `200` | espera depois da primeira falha; dobra a cada tentativa, até 5 s |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | intervalo do relay quando não há aviso de mensagem nova |
| `OUTBOX_BATCH_SIZE` | `100` | mensagens por lote do relay |
| `LOG_LEVEL` | `info` | nível do log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | endereço do OTel Collector |

No Compose, `DATABASE_PASSWORD` vem de `CHECKIN_DB_PASSWORD` e `TICKET_QR_KEY` de `TICKET_QR_KEY` (padrão `lotou-dev-ticket-qr-key`, só para desenvolvimento).
