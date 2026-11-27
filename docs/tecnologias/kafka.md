# Kafka no Lotou

O Kafka é o lugar onde o Lotou registra **o que aconteceu**: "o pedido foi confirmado", "o lote esgotou", "o ingresso entrou pelo portão B". Também leva os comandos da saga de compra ("autorize este pagamento"). Ele roda em modo KRaft (sem ZooKeeper), num broker só no Compose.

## Os conceitos, em uma imagem

```mermaid
flowchart LR
    prod["Produtor<br/>order-service"] -- "chave = orderId" --> t
    subgraph t["Tópico order.events"]
        p0["Partição 0<br/>evento 1, 2, 3, ..."]
        p1["Partição 1<br/>evento 1, 2, ..."]
        p2["Partição 2<br/>evento 1, 2, 3, 4, ..."]
    end
    t --> g1["Grupo notification-service<br/>lê no seu ritmo"]
    t --> g2["Grupo checkin-service<br/>lê no seu ritmo"]
    t --> g3["Grupo analytics-service.gen-3<br/>pode reler do começo"]
```

- **Tópico:** um log de mensagens, só de acréscimo. Ler uma mensagem não a apaga.
- **Partição:** cada tópico é dividido em partes (3 no Compose). A **chave** da mensagem escolhe a partição, e dentro de uma partição a ordem é garantida. Por isso todos os eventos de um pedido usam o `orderId` como chave: quem lê vê `OrderCreated` antes de `OrderConfirmed`, sempre.
- **Grupo de consumidores:** cada serviço que lê um tópico é um grupo e guarda até onde já leu (o *offset*). Dois serviços leem o mesmo evento, cada um no seu ritmo; se um cai, ele continua de onde parou quando volta.
- **Retenção:** quanto tempo as mensagens ficam. No Lotou depende do papel do tópico (abaixo).

## Os tópicos e quem fala com quem

```mermaid
flowchart LR
    ev["event-service"] --> sc[["shows.catalog"]] --> c1["inventory · order<br/>checkin · analytics"]
    ord["order-service"] --> oe[["order.events"]] --> c2["analytics · notification<br/>checkin"]
    inv["inventory-service"] --> ie[["inventory.events"]] --> c3["order · analytics<br/>event-service"]
    ck["checkin-service"] --> ce[["checkin.events"]] --> c4["analytics · order"]
    ord2["order-service"] --> pc[["payment.commands"]] --> c5["payment-mock"]
    pay["payment-mock"] --> pe[["payment.events"]] --> c6["order"]
    ord3["order-service"] --> ic[["inventory.commands"]] --> c7["inventory"]
```

Cada linha é um tópico: à esquerda quem publica, à direita quem lê. As quatro primeiras são fatos; as três últimas são a conversa da saga de compra.

| Tópico | O que carrega | Retenção | Por quê |
| --- | --- | --- | --- |
| `shows.catalog` | o show inteiro a cada mudança | compactado: fica só a última versão de cada show | um serviço novo lê o catálogo atual do começo, sem chamar o event-service |
| `order.events` | a vida do pedido e dos ingressos | para sempre | é a fonte para reconstruir os relatórios do zero |
| `inventory.events` | reservas confirmadas e liberadas, lotes esgotados e abertos | para sempre | idem |
| `checkin.events` | entradas e leituras recusadas na portaria | para sempre | idem |
| `payment.commands`, `payment.events`, `inventory.commands` | comandos e respostas da saga | 7 dias | só interessam enquanto a compra está acontecendo |
| `*.dlt` | mensagens que um consumidor não conseguiu processar | 7 dias | para inspeção; ninguém as lê automaticamente |

**Fatos no passado, comandos no imperativo.** `OrderConfirmed` é um fato: já aconteceu, quem quiser reage. `AuthorizePayment` é um comando: um serviço específico deve fazer algo e responder. Os dois usam o mesmo envelope:

```json
{
  "eventId": "01a21d08-...",
  "type": "OrderConfirmed",
  "version": 1,
  "occurredAt": "2026-11-27T20:31:04Z",
  "payload": { "orderId": "...", "showId": "...", "totalCents": 5000 }
}
```

O contexto do trace vai no cabeçalho `traceparent` da mensagem, para o trace continuar do outro lado. Cada mensagem tem um JSON Schema e um exemplo em [`contracts/`](../../contracts/), conferidos no CI (ADR 28). Nenhum evento leva CPF ou e-mail.

## Onde o Kafka aparece no Lotou

### 1. A saga da compra

O pagamento não acontece na mesma requisição em que o comprador clica em pagar. O order-service grava o pedido como PENDING, responde na hora e conduz o resto por mensagens. Ele é o **orquestrador**: guarda o passo de cada pedido em `saga_state` e decide o próximo comando a cada resposta (ADR 7).

```mermaid
stateDiagram-v2
    [*] --> PENDING: pedido criado
    PENDING --> AguardandoPagamento: AuthorizePayment
    AguardandoPagamento --> AguardandoReserva: PaymentAuthorized<br/>envia ConfirmReservation
    AguardandoPagamento --> CANCELLED: PaymentDeclined<br/>envia ReleaseReservation
    AguardandoReserva --> CONFIRMED: ReservationConfirmed<br/>emite os ingressos
    AguardandoReserva --> CANCELLED: reserva já expirou<br/>envia RefundPayment
    CONFIRMED --> [*]
    CANCELLED --> [*]
```

Se uma resposta não chega no prazo, o order-service repete o comando. Repetir é seguro porque todo consumidor é **idempotente**: o `eventId` de cada evento processado é gravado junto com o efeito (na tabela `processed_events` dos serviços com Postgres; no notification-service, numa marca no Redis), e um evento repetido é ignorado. O payment-mock responde igual a um comando repetido, sem cobrar duas vezes.

O cancelamento com reembolso é outra saga do mesmo jeito: `RefundPayment` ao payment-mock e `ReturnTickets` ao inventory, com tentativas e, depois de 5 falhas, o pedido em REFUND_FAILED para o produtor reprocessar.

### 2. O outbox: gravar e publicar sem perder nada

O problema clássico: o order-service grava o pedido no Postgres e publica no Kafka. Se ele cair entre as duas coisas, o pedido existe e ninguém fica sabendo (ou o contrário). A solução é o **outbox transacional** (ADR 8):

```mermaid
flowchart LR
    subgraph tx["Uma transação no Postgres"]
        a["UPDATE orders<br/>status = CONFIRMED"]
        b["INSERT INTO outbox<br/>OrderConfirmed"]
    end
    tx --> relay["Relay<br/>a cada instante lê o outbox,<br/>com advisory lock"]
    relay -- "publica em ordem" --> k[["order.events"]]
    relay -- "marca como publicado" --> tx
```

O pedido e a mensagem são gravados juntos ou não são gravados. Um relay (com advisory lock, para só uma instância publicar) lê o outbox em ordem, publica e marca como publicado. Se cair no meio, publica de novo, e o consumidor idempotente ignora a repetição. No inventory, o outbox é preenchido por trigger do próprio Postgres. No event-service, o outbox fica no MongoDB, na mesma transação do show, e é publicado em transações do Kafka (ADR 29).

### 3. A portaria com uma cópia dos ingressos

O checkin-service lê `TicketsIssued` e `TicketsCancelled` e mantém a própria tabela de ingressos válidos. Na hora do show, ele não pergunta nada ao order-service: se o order-service cair, a portaria continua funcionando (ADR 14). O preço é um pequeno atraso: um ingresso comprado agora leva alguns milissegundos para chegar à portaria, e um alerta avisa se esse atraso (o *lag* do consumidor) crescer.

### 4. Os relatórios do produtor, reconstruídos do zero

O analytics-service monta o painel ao vivo e o relatório financeiro lendo os eventos. Como `order.events`, `inventory.events` e `checkin.events` guardam tudo para sempre, dá para apagar os relatórios e montá-los de novo, por exemplo depois de corrigir um bug no cálculo. O `make replay-analytics` faz isso **sem parar o painel** (ADR 30):

```mermaid
sequenceDiagram
    participant K as Kafka (desde o começo)
    participant G3 as Geração 3 (ativa)
    participant G4 as Geração 4 (nova)
    participant V as View order_view
    Note over G3,V: o painel lê a view, que aponta para a geração 3
    K->>G4: novo grupo analytics-service.gen-4 lê tudo do offset 0
    G4->>G4: monta coleções order_view_g4, sales_by_sector_g4, ...
    Note over G4: alcançou o fim dos tópicos
    G4->>V: troca o ponteiro, de uma vez
    Note over V: o painel passa a ler a geração 4
```

### 5. Avisos entre serviços

Um `LotSoldOut` faz o event-service apagar o cache da página do show (o preço mudou). Um `ShowUpdated` com o show cancelado faz o order-service enfileirar o reembolso de todos os pedidos. Um `TicketCheckedIn` faz o order-service marcar o ingresso como usado, o que impede o cancelamento.

## Quando algo dá errado

- **Mensagem que não dá para processar** (formato inválido, bug): depois de algumas tentativas, o consumidor a publica em `<tópico>.dlt` e segue em frente. Um alerta no Grafana avisa quando chega mensagem num DLT.
- **Consumidor parado ou lento:** o Kafka guarda as mensagens; o lag cresce e aparece no dashboard de mensageria. O `make load-consumer-lag` demonstra isso parando o analytics-service e medindo quanto ele leva para alcançar.
- **Partição quente:** um show enorme concentra os eventos dele numa partição só (a chave é o show). Medido nos testes de carga; se virar gargalo, a chave muda para show e setor.

## Por que Kafka, e não só RabbitMQ ou chamadas HTTP

- **Vários leitores para o mesmo fato.** O `TicketsIssued` interessa a três serviços. No Kafka, cada um lê sem que o order-service saiba quem são.
- **Releitura.** Uma fila apaga a mensagem depois de entregue; o Kafka a guarda, e é isso que permite o replay dos relatórios.
- **Ordem por chave.** Os eventos de um pedido chegam na ordem em que aconteceram.
- **Desacoplamento no tempo.** Se o analytics cair por uma hora, nada se perde e a venda não para.

O RabbitMQ continua melhor para distribuir tarefas com tentativas e prioridade, e é usado para isso ([RabbitMQ](rabbitmq.md)). A comparação com Redis Streams e pub/sub está no ADR 11.

## Onde está no código

| O quê | Onde |
| --- | --- |
| Criação dos tópicos | [`infra/kafka/create-topics.sh`](../../infra/kafka/create-topics.sh) |
| Contratos (JSON Schema e exemplos) | [`contracts/`](../../contracts/) |
| Saga e relay do outbox do pedido | `services/order-service/src/main/java/br/com/lotou/order/saga` e `.../order/messaging` |
| Comandos e catálogo no inventory | `services/inventory-service/src/main/java/br/com/lotou/inventory/messaging` e `.../inventory/catalog` |
| Read models e replay | `services/analytics-service/src/analytics` |

Decisões relacionadas: [ADR 1](../adr/0001-kafka-para-eventos-de-dominio.md) (Kafka para eventos de domínio), [ADR 7](../adr/0007-saga-orquestrada-pelo-order-service.md) (saga orquestrada), [ADR 8](../adr/0008-outbox-transacional.md) (outbox), [ADR 11](../adr/0011-pubsub-streams-e-kafka.md) (pub/sub, Streams e Kafka), [ADR 14](../adr/0014-portaria-com-copia-local-dos-ingressos.md) (portaria com cópia local), [ADR 28](../adr/0028-contratos-em-json-schema.md) (contratos), [ADR 29](../adr/0029-outbox-do-event-service-no-mongodb.md) (outbox no MongoDB), [ADR 30](../adr/0030-replay-dos-read-models.md) (replay).
