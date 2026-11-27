# Painel ao vivo do produtor: protocolo do WebSocket

O analytics-service é o hub de tempo real do painel (ADR 17). A loja Angular abre um WebSocket por aba do painel e assina os shows que quer acompanhar. Este documento é o contrato entre os dois lados.

## Conexão

- Endereço: `wss://<loja>/api/v1/analytics/live` (pelo nginx da loja e pelo gateway, até o analytics em `/v1/analytics/live`).
- O navegador não manda cabeçalho `Authorization` num WebSocket, e o token não vai na URL (ADR 27). Por isso a **primeira mensagem do cliente é a autenticação**, e o servidor fecha a conexão se ela não chegar em 5 s.
- Mensagens em JSON, uma por frame de texto. O servidor manda ping de protocolo a cada 20 s; o cliente reconecta com espera exponencial e jitter se a conexão cair, e assina de novo.

## Cliente → servidor

| `type` | Campos | Quando |
| --- | --- | --- |
| `auth` | `token` (o access token do Keycloak) | primeira mensagem; de novo quando o token é renovado |
| `subscribe` | `showId` | passa a receber o show; só shows do produtor do token |
| `unsubscribe` | `showId` | para de receber |

## Servidor → cliente

| `type` | Campos | Quando |
| --- | --- | --- |
| `ready` | `user` (o `sub`) | token aceito (também depois de cada `auth` de renovação) |
| `snapshot` | `showId`, `metrics`, `activity` (até 50, do mais novo ao mais antigo) | logo depois do `subscribe` |
| `metrics` | `showId`, `metrics` | 1 vez por segundo, enquanto houver assinantes do show |
| `activity` | `showId`, `entry` | assim que o fato chega ao analytics |
| `error` | `code`, `detail`, `showId` (opcional) | `forbidden` (show de outro produtor ou inexistente), `bad-request` (mensagem fora do protocolo, ou mais de 20 shows na mesma conexão) |

Fechamentos: `4401` (token ausente, inválido ou expirado, ou renovação com o token de outro usuário), `4403` (sem o papel `producer`), `4408` (autenticação não chegou a tempo), `1013` (tente mais tarde: o cliente não acompanhou o envio, ou uma falha temporária do servidor; reconecte e assine de novo). Um `unsubscribe` não tem resposta.

### `metrics`

```json
{
  "at": "2026-11-26T18:00:01Z",
  "ticketsSold": 1240,
  "revenueCents": 18600000,
  "ordersConfirmed": 610,
  "ordersCancelled": 42,
  "ordersLastMinute": 37,
  "sectors": [
    {
      "sectorId": "…", "name": "Pista", "capacity": 2000, "sold": 1180, "remaining": 820,
      "currentLot": { "lotId": "…", "name": "2º lote", "priceCents": 15000, "status": "ON_SALE" }
    }
  ]
}
```

`remaining` é capacidade menos vendidos (reservas seguradas não contam). `currentLot` vem da linha do tempo dos lotes; `null` antes da abertura.

### `entry` (feed de atividade)

```json
{ "id": "1764180001000-0", "eventId": "…", "type": "OrderConfirmed", "at": "2026-11-26T18:00:01Z",
  "orderId": "…", "sectorName": "Pista", "quantity": 2, "totalCents": 30000 }
```

| `type` | Campos além de `id`, `eventId`, `type` e `at` |
| --- | --- |
| `OrderConfirmed` | `orderId`, `sectorName`, `quantity`, `totalCents` |
| `OrderCancelled` | `orderId`, `reason`, `totalCents` |
| `LotOpened` | `sectorName`, `lotName`, `priceCents` |
| `LotSoldOut` | `sectorName`, `lotName` |

`id` é o ID da entrada no Redis Stream `stream:activity:{showId}`; `at` é o `occurredAt` do fato. Nada de comprador, CPF ou e-mail no feed. Em `LotOpened` e `LotSoldOut`, `sectorName` e `lotName` vêm do catálogo e são `null` no caso raro de o lote chegar ao analytics antes do show.

## Medida do critério da fase 4

"Evento chega ao painel em menos de 2 s": do `occurredAt` do fato no Kafka ao frame `activity` recebido pelo cliente. O analytics publica a métrica `dashboard_event_delay_seconds` (histograma) com o atraso até o envio do frame.
