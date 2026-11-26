# inventory-service

Lotes, disponibilidade e reservas de pista e de cadeira numerada. Java 21, Spring Boot 4, Spring Data JPA e Postgres (Flyway).

É o dono do estoque: decide o que está à venda, a que preço, e garante as duas invariantes do projeto do lado da reserva: **nunca reservar além da capacidade** e **nunca segurar a mesma cadeira duas vezes**.

Na fase 1 a reserva usa lock no Postgres (`SELECT ... FOR UPDATE`). É de propósito: ela é a linha de base que a reserva no Redis precisa superar na fase 2.

## Como a reserva funciona

Uma reserva é uma transação só, que trava as linhas sempre na mesma ordem (para não haver deadlock):

1. **Cota do CPF.** Um único `INSERT ... ON CONFLICT DO UPDATE ... WHERE quantidade + n <= 4` confere e incrementa o limite de 4 ingressos por CPF em cada show. O CPF só é gravado como HMAC ([ADR 24](../../docs/adr/0024-cpf-como-hmac-e-limite-por-cpf-no-banco.md)).
2. **Lotes do setor.** Os lotes do setor são travados e o lote em venda perde `n` ingressos. Se o contador zera, o lote esgota e o próximo abre ([`SectorLots`](src/main/java/br/com/lotou/inventory/lot/SectorLots.java)).
3. **Cadeiras.** Na cadeira numerada, as cadeiras pedidas são travadas em ordem de ID e seguradas todas ou nenhuma.

Se qualquer passo recusa, a transação inteira é desfeita. A reserva dura 10 minutos; um job varre o banco e devolve à venda o que expirou.

## API

Atrás do gateway, as rotas ganham o prefixo `/api`.

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/v1/availability/{showId}` | público | por setor: situação da venda, lote em venda, preço e ingressos restantes |
| `GET` | `/v1/availability/{showId}/sectors/{sectorId}/seats` | público | cadeiras do setor e quais estão livres |
| `POST` | `/v1/reservations` | comprador | reserva ingressos (exige `Idempotency-Key`) |
| `GET` | `/v1/reservations/{id}` | dono | a reserva e o prazo dela |
| `POST` | `/v1/lots/{id}/pause`, `/resume` | produtor dono do show | pausa e retoma um lote |
| `GET` | `/internal/v1/reservations/{id}` | conta de serviço | reserva com o dono, para o order-service |
| `POST` | `/internal/v1/reservations/{id}/confirm`, `/release` | conta de serviço | pagamento aprovado ou recusado (idempotentes) |

As rotas `/internal` não passam pelo gateway e exigem o papel `service`.

Erros em Problem Details (RFC 9457), com `type` em `urn:lotou:problem:<tipo>`:

| Tipo | Status | Quando |
| --- | --- | --- |
| `validation-error` | 400 | campo inválido, CPF inválido ou `Idempotency-Key` ausente |
| `sold-out` | 409 | os ingressos do setor esgotaram |
| `insufficient-stock` | 409 | o lote em venda tem menos ingressos que o pedido (`available` diz quantos) |
| `seat-unavailable` | 409 | cadeira já escolhida por outra pessoa (`seats` lista quais) |
| `sales-not-open`, `sales-paused`, `sales-closed` | 409 | o setor não está vendendo agora |
| `reservation-not-held` | 409 | a reserva expirou, foi liberada ou já foi confirmada |
| `invalid-state-transition` | 409 | transição de estado fora da tabela |
| `purchase-limit-exceeded` | 422 | passaria de 4 ingressos por CPF no show (`remaining` diz quantos restam) |
| `seat-not-found` | 422 | cadeira que não existe no setor |
| `idempotency-key-reused` | 422 | mesma `Idempotency-Key` com outro pedido |

## De onde vêm os shows

O inventory não cadastra shows: ele mantém uma cópia do catálogo do event-service (shows, setores, lotes e uma linha por cadeira). Na fase 1 essa cópia é lida por polling ([`CatalogSyncJob`](src/main/java/br/com/lotou/inventory/catalog/CatalogSyncJob.java)), com o token da conta de serviço do inventory; na fase 3 vira o tópico `shows.catalog` no Kafka ([ADR 23](../../docs/adr/0023-fase-1-sem-broker-integracao-sincrona.md)).

Três jobs rodam de tempos em tempos, todos seguros para várias instâncias (cada um trava a linha no banco e confere a condição de novo): leitura do catálogo, ciclo das vendas (abre, vira lote por data e encerra) e expiração de reservas.

## Estrutura

```
src/main/java/br/com/lotou/inventory/
├── catalog/        # cópia do catálogo: show, setores e a leitura do event-service
├── lot/            # lotes, tabela de estados, regras de virada e ciclo das vendas
├── seat/           # cadeiras numeradas
├── reservation/    # reserva, limite por CPF, expiração e API
├── availability/   # leitura pública do que está à venda
├── shared/         # Problem Details, segurança, CPF e UUID v7
└── config/
src/main/resources/db/migration/   # esquema (Flyway)
```

## Comandos

```bash
./mvnw test      # regras de lote sem banco e testes de concorrência num Postgres real (precisa de Docker)
./mvnw package
```

Os testes de concorrência disparam as reservas no mesmo instante: 200 compradores para 50 ingressos, 100 compradores para as mesmas cadeiras, 30 pedidos do mesmo CPF.

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `8082` | porta HTTP |
| `DATABASE_URL`, `DATABASE_USERNAME`, `DATABASE_PASSWORD` | banco `inventory` local | conexão com o Postgres |
| `EVENT_SERVICE_URL` | `http://localhost:3001` | de onde ler o catálogo |
| `AUTH_ISSUER`, `AUTH_JWKS_URI`, `AUTH_AUDIENCE` | realm local | validação do JWT |
| `AUTH_TOKEN_URI`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` | realm local | token da conta de serviço |
| `CPF_HASH_KEY` | chave de desenvolvimento | chave do HMAC do CPF |
| `RESERVATION_TTL` | `10m` | duração da reserva |
| `JOBS_ENABLED` | `true` | liga os jobs agendados |
