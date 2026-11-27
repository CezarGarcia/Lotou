# APIs da fase 6: portaria, cancelamento, cupons, taxa e financeiro

Contrato entre a loja e os serviços para o que entra na fase 6. Todas as rotas passam pelo gateway com o prefixo `/api` (o serviço vê `/v1/...`). Erros em Problem Details (`type` = `urn:lotou:problem:<slug>`), dinheiro em centavos, datas em UTC (ISO 8601), IDs em UUID v7, listas paginadas por cursor (`?cursor=&limit=`, resposta `{items, nextCursor}`).

## Regras que valem para todos

- **Taxa de serviço:** 10% do valor de cada ingresso (antes do desconto), arredondada para o centavo mais próximo, por ingresso. Se o show repassa a taxa (`serviceFeePaidBy = BUYER`), ela é somada ao total do comprador; se o produtor absorve (`PRODUCER`), sai do valor a receber dele.
- **Cupom:** desconto percentual (`percent`, 1 a 100) ou fixo por pedido (`amountCents`), só sobre os ingressos, nunca sobre a taxa; centavos arredondados para baixo (a favor do comprador); nunca deixa os ingressos abaixo de zero. Um cupom por pedido; limite de usos, validade e, opcionalmente, setores.
- **Total cobrado** = subtotal − desconto + taxa (se `BUYER`).
- **Cancelamento pelo comprador:** só pedido `CONFIRMED`, até 7 dias depois da confirmação e com mais de 48 h para o show; nenhum ingresso `USED`. É do pedido inteiro, com reembolso integral, taxa incluída.
- **Show cancelado pelo produtor:** todos os pedidos `CONFIRMED` entram em reembolso automático, com controle de vazão.

## event-service

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `POST`, `PATCH` | `/v1/shows`, `/v1/shows/{id}` | produtor | novo campo `serviceFeePaidBy`: `BUYER` (padrão) ou `PRODUCER`; não muda depois que as vendas abrem |
| `POST` | `/v1/shows/{id}/cancel` | dono | `PUBLISHED` ou `ON_SALE` → `CANCELLED`; publica `ShowUpdated` |

## order-service

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `POST` | `/v1/orders/quote` | comprador | `{reservationId, couponCode?}` → `{subtotalCents, discountCents, serviceFeeCents, serviceFeePaidBy, totalCents, coupon}` sem criar nada; `coupon` é `null` ou `{code, kind, percent, amountCents}` |
| `POST` | `/v1/orders` | comprador | `{reservationId, couponCode?}`, com `Idempotency-Key`; o uso do cupom é contado aqui e devolvido se o pedido for cancelado ou reembolsado |
| `GET` | `/v1/orders/{id}` | dono | o pedido; campos novos abaixo |
| `POST` | `/v1/orders/{id}/cancel` | dono | pede o cancelamento: `202` com o pedido em `REFUNDING`; repetir é seguro |
| `POST` | `/v1/orders/{id}/refund/retry` | produtor dono do show | pedido em `REFUND_FAILED` volta a `REFUNDING` |
| `GET` | `/v1/orders/refund-failed?showId=` | produtor dono do show | pedidos que precisam de tratamento manual |
| `POST` | `/v1/coupons` | produtor dono do show | `{showId, code, kind: PERCENT\|AMOUNT, percent?, amountCents?, maxUses, validUntil, sectorIds?}`, com `Idempotency-Key` |
| `GET` | `/v1/coupons?showId=` | produtor dono do show | cupons do show |
| `POST` | `/v1/coupons/{id}/pause`, `/resume` | produtor dono do show | pausa e retoma |

Pedido (`GET /v1/orders/{id}`), campos novos: `subtotalCents`, `discountCents`, `serviceFeeCents`, `serviceFeePaidBy`, `couponCode` (ou `null`), `refundedCents` e `refundedAt` (ou `null`), `cancellation: {allowed, reason, deadline}` (`reason` quando não pode: `NOT_CONFIRMED`, `WINDOW_EXPIRED`, `TOO_CLOSE_TO_SHOW`, `TICKET_USED`; `deadline` é até quando pode). Estados novos: `REFUNDING`, `REFUNDED`, `REFUND_FAILED`. Ingresso: `status` pode ser `USED` (com `usedAt` e `gate`) ou `CANCELLED`.

Cupom: `{id, showId, code, kind, percent, amountCents, maxUses, uses, remaining, status: ACTIVE|PAUSED|EXPIRED|EXHAUSTED, validUntil, sectorIds, discountGivenCents, createdAt}`.

Erros novos: `coupon-invalid` (422, com `reason`: `NOT_FOUND`, `EXPIRED`, `PAUSED`, `EXHAUSTED`, `WRONG_SHOW`, `WRONG_SECTOR`), `coupon-code-taken` (409), `cancellation-not-allowed` (409, com `reason`).

## checkin-service

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `GET` | `/v1/checkins/shows` | portaria | shows de hoje e dos próximos dias, da cópia local: `{showId, title, artist, startsAt, timezone, doorsOpenAt, venueName}` |
| `POST` | `/v1/checkins` | portaria | `{showId, gate, code}` → sempre `200` com `{result, ticket, firstEntry}` |
| `GET` | `/v1/checkins/shows/{showId}/summary` | portaria ou produtor dono | `{checkedIn, byGate: [{gate, count}], rejected}` |

`result`: `ACCEPTED` (verde), `ALREADY_USED` (amarelo, com `firstEntry: {at, gate}`), `INVALID_CODE`, `UNKNOWN_TICKET`, `CANCELLED`, `WRONG_SHOW`, `NOT_OPEN` (vermelho; `NOT_OPEN` antes de `doorsOpenAt`). `ticket`: `{ticketId, sectorName, seat}` quando conhecido.

## analytics-service

- Relatório (`/v1/analytics/shows/{id}/statement`): `grossSalesCents` (subtotal dos pedidos confirmados), `discountsCents`, `refundsCents` (subtotal − desconto dos pedidos reembolsados), `platformFeeCents` (taxa absorvida pelo produtor), `buyerFeesCents` (taxa paga pelos compradores, informativa), `receivableCents` = bruto − descontos − reembolsos − taxa absorvida, `refundedOrders`, `partial`.
- Interno: `GET /internal/v1/shows/{id}/statement` (papel `service`), o mesmo relatório para o notification-service gerar o PDF.
- Painel ao vivo (`contracts/realtime-dashboard.md`): `metrics` ganha `checkedIn`, `checkinsByGate: [{gate, count}]` e `ordersRefunded`; o feed ganha `TicketCheckedIn` (`sectorName`, `gate`) e `OrderRefunded` (`orderId`, `refundedCents`, `reason`).

## notification-service

| Método | Rota | Quem | O que faz |
| --- | --- | --- | --- |
| `POST` | `/v1/reports/statements` | produtor dono do show | `{showId}` → `202`; o PDF do relatório financeiro chega por e-mail (fila `reports.generate`) |

E-mail novo: reembolso concluído (`OrderRefunded`).

## Gateway

| Rota | Serviço | Acesso |
| --- | --- | --- |
| `/api/v1/coupons/**` | order-service | `producer` |
| `/api/v1/orders/**` | order-service | `buyer` ou `producer` (o serviço confere quem pode o quê) |
| `/api/v1/checkins/**` | checkin-service | `gate-staff` ou `producer` |
| `/api/v1/reports/**` | notification-service | `producer` |
