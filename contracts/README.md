# Contratos dos eventos

Cada mensagem que passa pelo Kafka tem um JSON Schema aqui, e um exemplo em [`examples/`](examples/). O produtor valida o que publica contra o schema nos testes, e o consumidor testa a leitura com o exemplo. `python contracts/check.py` confere que todo schema tem exemplo e que o exemplo passa; o CI roda a conferência a cada mudança nesta pasta.

## Envelope

Toda mensagem tem o mesmo envelope:

```json
{
  "eventId": "01a21a00-0000-7000-8000-000000000021",
  "type": "OrderConfirmed",
  "version": 1,
  "occurredAt": "2026-11-26T18:00:02Z",
  "payload": { }
}
```

| Campo | Regra |
| --- | --- |
| `eventId` | UUID v7, único por mensagem. O consumidor grava o `eventId` junto com o efeito (`processed_events`) e ignora uma mensagem repetida |
| `type` | eventos no passado (`OrderConfirmed`), comandos no imperativo (`AuthorizePayment`) |
| `version` | versão do payload daquele tipo. Mudança que quebra o consumidor (remover ou renomear campo, mudar tipo) cria uma versão nova, com schema novo, e o produtor publica as duas enquanto houver consumidor da antiga. Campo novo opcional não muda a versão |
| `occurredAt` | quando o fato aconteceu, em UTC (ISO 8601) |
| `payload` | o fato em si; dinheiro em centavos (inteiro), datas em UTC, IDs em UUID |

Cabeçalhos da mensagem no Kafka: `traceparent` (e `tracestate`, quando houver), para o trace atravessar o broker. CPF e e-mail nunca entram em evento nenhum.

O valor é o envelope em JSON (UTF-8); a chave é o ID do agregado, em texto. O consumidor ignora tipos que não conhece, para um produtor poder começar a publicar um tipo novo antes de todos os consumidores o tratarem.

## Tópicos

| Tópico | Chave | Mensagens | Produz | Consome | Retenção |
| --- | --- | --- | --- | --- | --- |
| `shows.catalog` | `showId` | ShowPublished, ShowUpdated | event-service | inventory, analytics, order-service, checkin-service | compactado: fica a última versão de cada show |
| `order.events` | `orderId` | OrderCreated, OrderConfirmed, OrderCancelled, TicketsIssued, TicketsCancelled, OrderRefunded, OrderRefundFailed | order-service | analytics, notification, checkin | sem prazo: é a fonte do replay dos read models |
| `payment.commands` | `orderId` | AuthorizePayment, RefundPayment | order-service | payment-mock | 7 dias |
| `payment.events` | `orderId` | PaymentAuthorized, PaymentDeclined, PaymentRefunded, RefundFailed | payment-mock | order-service | 7 dias |
| `inventory.commands` | `orderId` | ConfirmReservation, ReleaseReservation, ReturnTickets | order-service | inventory | 7 dias |
| `inventory.events` | `showId` | ReservationConfirmed, ReservationReleased, ReservationReturned, LotSoldOut, LotOpened | inventory | order-service, analytics, event-service | sem prazo: o replay também lê daqui |
| `checkin.events` | `showId` | TicketCheckedIn, CheckinRejected | checkin-service | order-service, analytics | sem prazo: o replay também lê daqui |
| `<tópico>.dlt` | igual à origem | mensagens que falharam depois das tentativas | consumidores | inspeção manual | 7 dias |

A chave decide a partição, e a ordem só é garantida dentro dela: tudo de um pedido chega em ordem ao consumidor, e tudo de um show também (`LotSoldOut` antes do `LotOpened` do lote seguinte).

`ShowPublished` e `ShowUpdated` levam o show inteiro, com uma `version` que só cresce. O consumidor guarda a versão mais alta e ignora as anteriores, então reler o tópico do começo reconstrói o catálogo.

Os eventos do inventory levam `reservationId`, não o pedido: o order-service liga a reserva ao pedido, porque é ele que sabe qual pedido usou qual reserva.

## Pastas

```
contracts/
├── <tópico>/<Tipo>.v<versão>.schema.json   # JSON Schema (draft 2020-12), autocontido
├── examples/<tópico>/<Tipo>.v<versão>.json # uma mensagem válida, usada nos testes
└── check.py                                # confere schemas e exemplos
```

Cada schema é autocontido, sem `$ref` para outros arquivos, para que Java, Node e Python validem sem configurar resolução de referências.
