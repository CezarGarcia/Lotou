# MongoDB no Lotou

O MongoDB guarda **documentos**: um registro com o formato que ele precisar, com listas e objetos dentro. No Lotou ele tem dois papéis bem diferentes: o **catálogo de shows** (no event-service) e os **relatórios do produtor** (no analytics-service). Cada serviço tem o próprio banco na mesma instância, que roda como replica set de um nó só (`rs0`), porque as transações do MongoDB exigem isso.

![Os dois bancos do MongoDB na mesma instância. O banco event_service, do catálogo, tem as coleções events (os shows), venues (os locais e os mapas), idempotency_keys (apagadas em 24 h por TTL) e outbox; o produtor grava nele e a loja lê. Um relay publica o outbox no Kafka. O analytics-service lê os tópicos shows.catalog, order.events, inventory.events e checkin.events e monta no banco analytics as coleções order_view, sales_by_sector, producer_statements, checkins_by_gate, shows e lot_timeline, além de generations; o painel do produtor lê essas visões prontas, sem join.](img/mongodb-bancos.png)

## 1. O catálogo de shows

Um show é naturalmente um documento: título, artista, data, local, setores, lotes de cada setor, descrição, regras. Um local também: um teatro tem plateia e balcão com fileiras curvas; um estádio tem pista, arquibancada e cadeiras cobertas, cada um com uma estrutura diferente. Num banco relacional isso viraria muitas tabelas e muitos joins para montar uma página que é lida milhares de vezes e editada raramente.

```json
{
  "_id": "01a21cbe-80f7-710e-...",
  "title": "Vinte Anos de Estrada",
  "artist": "Os Tropicais do Asfalto",
  "status": "ON_SALE",
  "startsAt": "2026-12-17T23:30:00Z",
  "highDemand": false,
  "version": 4,
  "venue": { "id": "...", "name": "Teatro Guanabara", "city": "Rio de Janeiro", "state": "RJ", "timezone": "America/Sao_Paulo" },
  "sectors": [
    { "id": "...", "name": "Plateia", "kind": "RESERVED_SEATING", "capacity": 820,
      "lots": [ { "name": "1º lote", "priceCents": 16000, "quantity": 400 } ] }
  ]
}
```

- **Busca:** índices por artista, cidade e data. O resultado fica 60 s no `redis-cache` ([Redis](redis.md)).
- **Página do show:** lida pelo `_id`, com cache em dois níveis.
- **Idempotência dos POSTs:** a `Idempotency-Key` de cada criação fica em `idempotency_keys`, com a resposta original. O índice único do `_id` decide quem ganha quando duas requisições iguais chegam juntas, e um índice TTL apaga a chave depois de 24 h, sem job nenhum (ADR 22).
- **Outbox no próprio MongoDB:** quando o produtor publica ou edita um show, o documento e a mensagem `ShowUpdated` são gravados **na mesma transação** (por isso o replica set). Um relay publica no Kafka em transações do Kafka, com uma "concessão" em `outbox_leases` para só uma instância publicar por vez (ADR 29). É o mesmo padrão do outbox do Postgres, explicado em [Kafka](kafka.md).

## 2. Os relatórios do produtor (read models)

O produtor quer ver vendas por setor, receita, cupons, reembolsos e entradas na portaria, tudo junto e rápido. Esses dados estão espalhados em quatro serviços, cada um com o seu banco. Em vez de perguntar a todos a cada abertura do painel, o analytics-service **monta visões prontas** a partir dos eventos do Kafka. Isso é CQRS: o lado que escreve (pedidos, reservas) é separado do lado que lê (o painel).

| Coleção | O que tem | Atualizada por |
| --- | --- | --- |
| `order_view` | o pedido completo, já com show, setor, cupom e situação | `OrderCreated`, `OrderConfirmed`, `OrderRefunded`, ... |
| `sales_by_sector` | vendas, receita e ocupação por show, setor e hora | `OrderConfirmed`, `TicketsCancelled`, ... |
| `producer_statements` | o relatório financeiro: bruto, descontos, reembolsos, taxa, a receber | eventos de pedido e reembolso |
| `checkins_by_gate` | entradas por show e portão | `TicketCheckedIn` |
| `shows`, `lot_timeline` | a cópia do catálogo e quando cada lote abriu e esgotou | `shows.catalog`, `LotOpened`, `LotSoldOut` |

Documento é o formato certo aqui porque cada visão é **desnormalizada de propósito**: tudo o que a tela precisa já está junto, sem join.

### Reconstruir do zero, sem parar o painel

Como os eventos ficam no Kafka para sempre, as visões podem ser apagadas e montadas de novo. Cada montagem é uma **geração** com as próprias coleções (`order_view_g3`, `order_view_g4`). A API do painel lê qual é a geração ativa num ponteiro (o documento `analytics_state/active`), a coleção `generations` registra a situação de cada uma, e uma **view** do MongoDB com o nome simples (`order_view`) aponta para a ativa, para quem lê o banco de fora (o `mongosh`, o futuro assistente de IA).

![A view order_view, com o nome simples, aponta hoje para a geração ativa order_view_g3, alimentada pelo consumidor ao vivo; a order_view_g4 está sendo montada pelo replay, lendo os tópicos desde o primeiro evento, e passa a receber a view depois da troca. Embaixo, os três passos do replay: reservar a geração nova com coleções e consumer group próprios, ler tudo do começo até o fim que cada tópico tinha na partida enquanto quem lê continua na g3, e trocar de uma vez.](img/mongodb-geracoes.png)

Quando a geração nova alcança o fim dos tópicos, a view passa a apontar para ela de uma vez. Quem lê nem percebe (ADR 30). O `make replay-analytics` faz isso no ambiente.

### Cada evento uma vez

O analytics guarda o `eventId` de cada evento aplicado em `processed_events`, na mesma operação que atualiza a visão. Um evento entregue duas vezes pelo Kafka não conta duas vendas.

## Por que MongoDB aqui e Postgres no resto

| | Catálogo e relatórios (MongoDB) | Pedidos e ingressos ([Postgres](postgres.md)) |
| --- | --- | --- |
| Formato | varia de show para show, de local para local | fixo |
| Leitura | o documento inteiro de uma vez | linhas com joins e filtros |
| Escrita | rara (o produtor edita o show) ou vinda de eventos | constante, com dinheiro envolvido |
| Regra mais importante | ler rápido | nunca vender além da capacidade, nunca perder um pagamento |

## Onde ver e onde está no código

- `docker compose exec mongodb mongosh event_service` e `db.events.find({}, {title: 1, artist: 1})`; no banco `analytics`, `db.generations.find()`.

| O quê | Onde |
| --- | --- |
| Shows, locais e busca | [`services/event-service/src/shows/`](../../services/event-service/src/shows/) e [`src/venues/`](../../services/event-service/src/venues/) |
| Outbox no MongoDB | [`services/event-service/src/outbox/`](../../services/event-service/src/outbox/) |
| Read models e projeção | `services/analytics-service/src/analytics/projection.py` e `.../store/` |
| Replay em gerações | `services/analytics-service/src/analytics/replay/` |

Decisões relacionadas: [ADR 18](../adr/0018-um-banco-por-servico.md) (um banco por serviço), [ADR 22](../adr/0022-idempotency-key-do-event-service-no-mongodb.md) (Idempotency-Key no MongoDB), [ADR 29](../adr/0029-outbox-do-event-service-no-mongodb.md) (outbox no MongoDB), [ADR 30](../adr/0030-replay-dos-read-models.md) (replay em gerações).
