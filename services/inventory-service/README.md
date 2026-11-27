# inventory-service

Lotes, disponibilidade, reservas de pista e de cadeira numerada, fila virtual e mapa de assentos ao vivo. Java 21, Spring Boot 4, Redis (`redis-core`), Spring Kafka, Spring Data JPA e Postgres (Flyway).

É o dono do estoque: decide o que está à venda, a que preço, e garante as duas invariantes do projeto do lado da reserva: **nunca reservar além da capacidade** e **nunca segurar a mesma cadeira duas vezes**.

## Dois motores de reserva

`RESERVATION_ENGINE` escolhe onde a reserva acontece:

| Motor | Como reserva | Para quê |
| --- | --- | --- |
| `redis` (padrão) | script Lua no `redis-core`, atômico; o Postgres recebe o resultado por stream | a abertura de vendas (fase 2) |
| `postgres` | transação com `SELECT ... FOR UPDATE` | linha de base da fase 1, para comparar ([ADR 3](../../docs/adr/0003-reserva-com-lua-no-redis.md)) |

Os dois implementam [`ReservationEngine`](src/main/java/br/com/lotou/inventory/reservation/ReservationEngine.java) e [`SalesEngine`](src/main/java/br/com/lotou/inventory/lot/SalesEngine.java), e cada cenário de teste roda contra os dois. O motor é escolhido por implantação: trocar com as vendas abertas não é suportado.

### No Redis

Durante a venda, o Redis é a fonte da verdade ([ADR 26](../../docs/adr/0026-redis-como-fonte-da-verdade-durante-a-venda.md)):

1. **Carga.** Na abertura das vendas, um job com lock distribuído copia do Postgres para o Redis os setores, o estoque de cada lote, as cadeiras ocupadas e o bitmap do mapa. A marca `show:{id}` é gravada por último; sem ela, a reserva responde 503 `inventory-loading`. Se o Redis perder os dados, o job vê a marca sumir e carrega de novo.
2. **Reserva** ([`reserve.lua`](src/main/resources/redis/reserve.lua)). Um script confere, nesta ordem, a `Idempotency-Key`, a carga, o token da fila (em show de alta demanda), a cota do CPF, o status do lote, o estoque e as cadeiras. Só então muda tudo de uma vez: estoque, cota, cadeiras, bitmap, reserva e virada de lote se o contador zerou.
3. **Stream.** O mesmo script grava o estado final do que mudou em `stream:reservations` e publica as cadeiras em `seatmap.{showId}`.
4. **Projeção** ([`ReservationProjection`](src/main/java/br/com/lotou/inventory/redis/ReservationProjection.java)). Um consumer group lê o stream e grava no Postgres numa transação por lote, e só então confirma (`XACK`). Cada linha guarda a posição da entrada (`redis_seq`), e uma entrada mais antiga nunca sobrescreve uma mais nova: reaplicar não muda nada. Entradas de uma instância que caiu são assumidas por outra (`XPENDING` + `XCLAIM`), e o stream é aparado só até o que já chegou ao banco.

Confirmar, liberar, expirar, devolver ingressos vendidos, virar o lote por data, pausar, retomar e encerrar também são scripts, na pasta [`src/main/resources/redis/`](src/main/resources/redis/). Nada do estado da venda expira por TTL: a reserva vencida é encontrada pelo job que varre o Postgres e devolvida pelo script, que solta cadeiras, estoque e cota juntos.

### No Postgres

Uma transação só, que trava as linhas sempre na mesma ordem (para não haver deadlock): a cota do CPF (`INSERT ... ON CONFLICT DO UPDATE ... WHERE quantidade + n <= 4`), os lotes do setor e as cadeiras, em ordem de ID. Se qualquer passo recusa, a transação inteira é desfeita.

Nos dois motores, o CPF só é gravado como HMAC ([ADR 24](../../docs/adr/0024-cpf-como-hmac-e-limite-por-cpf-no-banco.md)), e a reserva dura 10 minutos.

## Estados da reserva

A tabela única de transições fica em [`ReservationStatus`](src/main/java/br/com/lotou/inventory/reservation/ReservationStatus.java); transição fora dela é recusada.

| De | Para | Gatilho |
| --- | --- | --- |
| HELD | CONFIRMED | pagamento aprovado (`ConfirmReservation`) |
| HELD | RELEASED | pagamento recusado (`ReleaseReservation`) |
| HELD | EXPIRED | 10 minutos sem pagamento (job de expiração) |
| CONFIRMED | RETURNED | pedido cancelado e reembolsado (`ReturnTickets`) |

RELEASED, EXPIRED e RETURNED são finais.

### Devolução de ingressos vendidos

`ReturnTickets` devolve à venda os ingressos de uma reserva confirmada ([`return.lua`](src/main/resources/redis/return.lua) no Redis, uma transação no Postgres), pelas mesmas regras da liberação: o estoque volta para o lote em venda do setor, ao preço dele, e, se o setor esgotou, o último lote reabre (ADR 25); as cadeiras voltam a AVAILABLE (e saem do bitmap) e a cota do CPF é devolvida. A cadeira devolvida pode ser vendida de novo: o ingresso cancelado fica no order-service, fora da regra de ingresso único.

- **Vendas encerradas:** os ingressos não voltam à venda, porque não há lote para recebê-los. Mesmo assim a reserva vira RETURNED, as cadeiras ficam livres e a cota é devolvida, e o fato sai normalmente.
- **Idempotente:** devolver uma reserva já devolvida não muda nada nem gera fato novo. Reserva que não está confirmada (HELD, RELEASED, EXPIRED) é recusada (`reservation-not-confirmed`) sem mudar nada.
- **Reserva fora do Redis:** a reserva concluída fica no Redis só por um dia, e o cancelamento pode chegar até 7 dias depois da compra. Sem o hash, o script roda com a reserva lida do Postgres; um hash que exista ainda vale mais que essa cópia.
- **Show fora do Redis** (o Redis perdeu os dados): com as vendas abertas, a resposta é `inventory-loading` e o consumidor repete o comando enquanto o job recarrega o show; com as vendas encerradas, o show não volta para o Redis, e a devolução é gravada direto no Postgres.

## Fila virtual

Só nos shows marcados como alta demanda, durante toda a venda ([ADR 13](../../docs/adr/0013-fila-virtual-so-em-shows-de-alta-demanda.md)):

- a sala de espera abre 30 minutos antes das vendas;
- na abertura, um script sorteia a ordem de quem estava na sala; quem chega depois entra no fim da fila;
- a cada segundo, os próximos `QUEUE_ADMISSION_RATE` recebem um token de 5 minutos, que o script da reserva confere;
- a posição chega ao navegador por SSE, uma vez por segundo, até a admissão.

O sorteio e a admissão rodam com lock no Redis ([`RedisLock`](src/main/java/br/com/lotou/inventory/redis/RedisLock.java)), então várias instâncias podem rodar o job.

## API

Atrás do gateway, as rotas ganham o prefixo `/api`.

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/v1/availability/{showId}` | público | por setor: situação da venda, lote em venda, preço e ingressos restantes |
| `GET` | `/v1/availability/{showId}/sectors/{sectorId}/seats` | público | cadeiras do setor e quais estão livres |
| `GET` | `/v1/availability/{showId}/sectors/{sectorId}/seats/events` | público | SSE: a foto do setor (`snapshot`) e as cadeiras que mudam (`seats`) |
| `POST` | `/v1/reservations` | comprador | reserva ingressos (exige `Idempotency-Key`) |
| `GET` | `/v1/reservations/{id}` | dono | a reserva e o prazo dela |
| `POST` | `/v1/queue/{showId}` | comprador | entra na sala de espera ou na fila |
| `GET` | `/v1/queue/{showId}` | comprador | situação na fila: posição, espera estimada ou admissão |
| `GET` | `/v1/queue/{showId}/events` | comprador | SSE: a situação na fila a cada segundo, até a admissão |
| `POST` | `/v1/lots/{id}/pause`, `/resume` | produtor dono do show | pausa e retoma um lote |
| `GET` | `/internal/v1/reservations/{id}` | conta de serviço | reserva com o dono, para o order-service |

As rotas `/internal` não passam pelo gateway e exigem o papel `service`.

Erros em Problem Details (RFC 9457), com `type` em `urn:lotou:problem:<tipo>`:

| Tipo | Status | Quando |
| --- | --- | --- |
| `validation-error` | 400 | campo inválido, CPF inválido ou `Idempotency-Key` ausente |
| `sold-out` | 409 | os ingressos do setor esgotaram |
| `insufficient-stock` | 409 | o lote em venda tem menos ingressos que o pedido (`available` diz quantos) |
| `seat-unavailable` | 409 | cadeira já escolhida por outra pessoa (`seats` lista quais) |
| `sales-not-open`, `sales-paused`, `sales-closed` | 409 | o setor não está vendendo agora |
| `queue-admission-required` | 409 | show de alta demanda e o comprador ainda não foi admitido pela fila |
| `reservation-not-held` | 409 | a reserva expirou, foi liberada ou já foi confirmada |
| `invalid-state-transition` | 409 | transição de estado fora da tabela |
| `purchase-limit-exceeded` | 422 | passaria de 4 ingressos por CPF no show (`remaining` diz quantos restam) |
| `seat-not-found` | 422 | cadeira que não existe no setor |
| `idempotency-key-reused` | 422 | mesma `Idempotency-Key` com outro pedido |
| `inventory-loading` | 503 | o estoque do show ainda está sendo carregado no Redis; tente de novo em instantes |

## Kafka

| Direção | Tópico | Mensagens |
| --- | --- | --- |
| consome | `shows.catalog` | ShowPublished, ShowUpdated: a cópia local do catálogo (shows, setores, lotes e uma linha por cadeira) |
| consome | `inventory.commands` | ConfirmReservation, ReleaseReservation (saga de compra) e ReturnTickets (saga de cancelamento), enviados pelo order-service |
| publica | `inventory.events` | ReservationConfirmed, ReservationReleased, ReservationReturned, LotSoldOut, LotOpened |

- **Catálogo** ([`CatalogListener`](src/main/java/br/com/lotou/inventory/catalog/CatalogListener.java)): cada mensagem traz o show inteiro com a versão; só uma versão mais nova muda a cópia local. Um consumer group novo relê o tópico compactado desde o começo e monta o catálogo inteiro. Lê só transações confirmadas (`read_committed`), porque o event-service publica em transações Kafka.
- **Comandos** ([`ReservationCommandListener`](src/main/java/br/com/lotou/inventory/reservation/ReservationCommandListener.java)): confirmam ou liberam a reserva, ou devolvem à venda os ingressos de uma reserva confirmada, pelo motor configurado. Não há resposta direta: a saga espera os fatos. Um comando para uma reserva que não existe ou não está no estado esperado é registrado em log e ignorado; uma falha passageira (o estoque do show sendo recarregado no Redis) é repetida com espera crescente e, se passar de 30 segundos, vai para a DLT.
- **Fatos:** toda mudança de status de reserva e de lote é gravada no outbox por um trigger do Postgres, na mesma transação, venha de qual motor ou job vier ([`V3__outbox_and_events.sql`](src/main/resources/db/migration/V3__outbox_and_events.sql); o ramo de RETURNED veio na [`V4__reservation_returned.sql`](src/main/resources/db/migration/V4__reservation_returned.sql)). Um relay publica em ordem, uma instância por vez ([ADR 8](../../docs/adr/0008-outbox-transacional.md)). Repetir um comando, ou recebê-lo tarde, não gera fato novo.

Os jobs, todos seguros para várias instâncias: ciclo das vendas (abre e carrega o Redis, vira lote por data, encerra e recarrega um show que o Redis perdeu), expiração de reservas, admissão da fila e o relay do outbox.

## Observabilidade

Além do que o Java agent do OpenTelemetry cobre (HTTP, JDBC), cada script Lua gera um span de cliente `EVALSHA <script>` com o resultado (`lotou.redis.result`), porque o agente não instrumenta o Lettuce 7. Métricas próprias:

| Métrica | O que mede |
| --- | --- |
| `ticket_reservations_total{result}`, `seat_hold_conflicts_total` | tentativas de reserva por tipo de setor e resultado, e recusas por cadeira ocupada |
| `reservation_stream_applied_total` | entradas do stream gravadas no Postgres |
| `queue_admitted_total`, `queue_wait_seconds`, `queue_length` | admissões, tempo de espera e tamanho da fila por show |
| `seatmap_connections` | navegadores com o mapa aberto |

## Estrutura

```
src/main/java/br/com/lotou/inventory/
├── catalog/        # cópia do catálogo (lida de shows.catalog) e cache em memória de setores, lotes e cadeiras
├── lot/            # lotes, tabela de estados, regras de virada e os dois motores do ciclo das vendas
├── seat/           # cadeiras numeradas
├── reservation/    # os dois motores de reserva, limite por CPF, expiração e API
├── redis/          # scripts Lua, carga e reconstrução, stream para o Postgres e lock
├── queue/          # fila virtual, admissão e SSE da posição
├── seatmap/        # SSE do mapa de assentos, alimentado pelo pub/sub
├── messaging/      # relay do outbox, leitura das mensagens e DLT
├── availability/   # leitura pública do que está à venda
├── shared/         # Problem Details, segurança, CPF e UUID v7
└── config/
src/main/resources/redis/          # scripts Lua (lib.lua é prefixado em cada um)
src/main/resources/db/migration/   # esquema (Flyway)
```

## Comandos

```bash
./mvnw test      # regras de lote sem banco e testes num Postgres e num Redis reais (precisa de Docker)
./mvnw package
```

Os testes de concorrência disparam as reservas no mesmo instante, contra os dois motores: 200 compradores para 50 ingressos, 100 compradores para as mesmas cadeiras, 30 pedidos do mesmo CPF. Há também testes da fila (sorteio, admissão e expiração do token) e da reconstrução do Redis depois de um `FLUSHALL`.

Os testes de carga ficam em [`load-tests/`](../../load-tests) e rodam pela raiz (`make load-opening`, `make load-contention`).

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `8082` | porta HTTP |
| `DATABASE_URL`, `DATABASE_USERNAME`, `DATABASE_PASSWORD` | banco `inventory` local | conexão com o Postgres |
| `REDIS_URL` | `redis://localhost:6380` | conexão com o `redis-core` |
| `RESERVATION_ENGINE` | `redis` | motor de reserva: `redis` ou `postgres` |
| `QUEUE_ADMISSION_RATE` | `100` | compradores admitidos por segundo em cada show de alta demanda |
| `KAFKA_BROKERS` | `localhost:9094` | o Kafka |
| `AUTH_ISSUER`, `AUTH_JWKS_URI`, `AUTH_AUDIENCE` | realm local | validação do JWT |
| `CPF_HASH_KEY` | chave de desenvolvimento | chave do HMAC do CPF |
| `RESERVATION_TTL` | `10m` | duração da reserva |
| `JOBS_ENABLED` | `true` | liga os jobs agendados |
