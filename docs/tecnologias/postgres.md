# Postgres no Lotou

O Postgres guarda o que **não pode ficar errado**: pedidos, ingressos, pagamentos, cupons, reembolsos e entradas na portaria. São os dados em que uma inconsistência vira prejuízo (ingresso vendido duas vezes, cupom usado além do limite, reembolso pago em dobro), e por isso precisam de transação e de constraints.

## Um banco por serviço

Uma instância só no Compose, com um banco e um usuário por serviço. Nenhum serviço consegue ler o banco de outro: quando precisa de um dado alheio, recebe pelo Kafka e guarda uma cópia (ADR 18).

![Uma instância do Postgres 18 com cinco bancos, cada um usado só pelo seu dono: inventory (lotes, cadeiras, reservas, limite por CPF, outbox) pelo inventory-service, orders (pedidos, ingressos, cupons, reembolsos, saga, outbox) pelo order-service, payments (tentativas e estornos) pelo payment-mock, checkin (ingressos válidos, entradas, leituras recusadas, outbox) pelo checkin-service e keycloak (usuários e sessões) pelo Keycloak. O Grafana, com o usuário observer, só de leitura, consulta os bancos inventory, orders e checkin para os alertas de invariante.](img/postgres-bancos.png)

As tabelas são criadas por migrações versionadas (Flyway nos serviços Java, scripts SQL nos serviços Node), na subida de cada serviço.

## O que o Postgres garante

### Tudo ou nada: transações

Criar um pedido com cupom faz várias coisas, e elas acontecem juntas ou nenhuma acontece:

![A transação de um pedido com cupom, entre BEGIN e COMMIT, em cinco passos: INSERT em orders com status PENDING; UPDATE em coupons somando um uso só onde uses é menor que max_uses, o cupom está ativo e no prazo; INSERT em coupon_redemptions; INSERT em saga_state; e INSERT no outbox de OrderCreated e AuthorizePayment. Se o UPDATE altera uma linha, tudo segue até o COMMIT; se altera zero, o cupom não tem uso sobrando, o pedido é recusado e o ROLLBACK desfaz as cinco escritas.](img/postgres-transacao-cupom.png)

Se o cupom já atingiu o limite, o `UPDATE` não muda nenhuma linha, o pedido é recusado e nada fica gravado pela metade. O mesmo vale para o cancelamento: pedido em reembolso, ingressos cancelados, passo da saga e mensagens no outbox, numa transação só.

### A última linha de defesa: constraints

O Redis decide quem fica com o ingresso durante a venda, e é muito rápido. Mas se ele falhar, o Postgres ainda impede o pior:

| Constraint | Impede |
| --- | --- |
| índice único parcial em `tickets (show, setor, cadeira)` | duas pessoas com ingresso para a mesma cadeira (ADR 4) |
| `CHECK (uses <= max_uses)` em `coupons` | cupom usado além do limite |
| único em `checkins.ticket_id` | duas entradas com o mesmo ingresso |
| único em `orders (comprador, idempotency_key)` | dois pedidos por um clique duplo |
| único em `processed_events.event_id` | o mesmo evento do Kafka aplicado duas vezes |

Os alertas de invariante do Grafana consultam essas tabelas a cada minuto ("algum setor com mais ingressos que a capacidade?", "algum ingresso com duas entradas?"). Se um dia der positivo, o e-mail chega no Mailpit.

### Gravar e avisar juntos: o outbox

A mensagem para o Kafka é gravada numa tabela `outbox`, na mesma transação da mudança. Um relay publica depois. Assim nunca acontece de o pedido ser confirmado e o resto do sistema não ficar sabendo. No inventory, um trigger grava no outbox a cada mudança de status de uma reserva ou de um lote. Detalhes em [Kafka](kafka.md).

### Cópias locais, alimentadas por eventos

| Serviço | Cópia de | Para quê |
| --- | --- | --- |
| inventory | `shows`, `sectors` (do catálogo) | conferir janela de vendas e capacidade sem chamar o event-service |
| order | `shows` | saber o produtor, a data e quem paga a taxa |
| checkin | `valid_tickets`, `shows` | validar a entrada mesmo com o order-service fora do ar (ADR 14) |

## O Postgres e o Redis na venda

Durante a venda, o estoque vive no Redis, e o Postgres recebe uma cópia durável pelo Redis Stream ([Redis](redis.md)). O inventory guarda a posição de cada entrada do stream (`redis_seq`) em cada linha, e nunca aplica uma entrada mais antiga por cima de uma mais nova. Se o Redis for perdido, o estado é recarregado do Postgres.

A primeira versão (fase 1) reservava com lock no Postgres (`SELECT ... FOR UPDATE`). Ela continua no código como motor alternativo, e o teste de carga compara os dois: `make load-contention ENGINE=postgres` contra `ENGINE=redis`.

## Privacidade

O CPF nunca é gravado como texto: `purchase_limits` usa um HMAC dele (ADR 24). E-mails ficam só no Keycloak.

## Onde ver e onde está no código

- `docker compose exec postgres psql -U orders orders` e `SELECT status, count(*) FROM orders GROUP BY 1;`
- O `make load-check` roda as consultas das invariantes depois de um teste de carga.

| O quê | Onde |
| --- | --- |
| Criação dos bancos e do usuário de leitura | [`infra/postgres/init/01-create-databases.sh`](../../infra/postgres/init/01-create-databases.sh) |
| Migrações do order-service | [`services/order-service/src/main/resources/db/migration/`](../../services/order-service/src/main/resources/db/migration/) |
| Migrações do inventory | [`services/inventory-service/src/main/resources/db/migration/`](../../services/inventory-service/src/main/resources/db/migration/) |

Decisões relacionadas: [ADR 4](../adr/0004-constraint-unica-de-show-e-assento.md) (constraint de show e assento), [ADR 8](../adr/0008-outbox-transacional.md) (outbox), [ADR 18](../adr/0018-um-banco-por-servico.md) (um banco por serviço), [ADR 24](../adr/0024-cpf-como-hmac-e-limite-por-cpf-no-banco.md) (CPF como HMAC), [ADR 33](../adr/0033-uso-do-cupom-contado-no-postgres.md) (cupom no Postgres).
