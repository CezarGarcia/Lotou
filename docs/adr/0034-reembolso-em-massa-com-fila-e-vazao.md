# 0034. Reembolso em massa com fila no Postgres e vazão controlada

- **Status:** aceita
- **Data:** 2026-11-27

## Contexto

Quando o produtor cancela um show, todos os pedidos confirmados precisam ser reembolsados. Num show grande são milhares de pedidos de uma vez. Mandar um `RefundPayment` para cada um no mesmo instante despejaria milhares de estornos no gateway de pagamento, que tem limite de requisições, e as falhas viriam em massa justamente quando mais importa que o reembolso dê certo.

Também há pedidos no meio da saga de compra quando o show é cancelado: eles só confirmam depois, e não podem ficar sem reembolso.

## Decisão

- A saga de reembolso guarda o passo de cada pedido em `refunds`, no Postgres do order-service: QUEUED, REFUNDING, COMPLETED ou FAILED.
- O `ShowUpdated` com `CANCELLED` põe na fila (QUEUED), na mesma transação que atualiza a cópia local do show, todos os pedidos confirmados dele.
- Um job (`RefundJob`) começa a cada segundo no máximo `REFUND_RATE` reembolsos da fila (20 por padrão): cancela os ingressos, publica `TicketsCancelled` e envia `RefundPayment`, cada um na sua transação, pelo outbox.
- A cada rodada o job também põe na fila os pedidos confirmados de shows cancelados que ainda não têm reembolso, o que pega os que confirmaram depois do cancelamento.
- O cancelamento pelo comprador não passa pela fila: começa direto em REFUNDING.
- Cinco falhas de estorno levam o pedido a REFUND\_FAILED, que o produtor reprocessa pela API.

## Alternativas consideradas

- **Mandar tudo de uma vez e deixar o payment-mock lidar.** Simples, mas transfere o problema para o gateway de pagamento e para o retry.
- **Uma fila no RabbitMQ com prefetch.** Daria a vazão, mas o estado do reembolso já precisa estar no Postgres, junto do pedido (ADR 7). Uma segunda fila seria outro lugar para o mesmo estado, e o comando já sai pelo outbox.

## Consequências

- A vazão sobre o pagamento é fixa e configurável, e o reembolso de um show inteiro leva um tempo previsível (10 mil pedidos a 20 por segundo: pouco mais de 8 minutos).
- A fila é uma consulta indexada (`refunds_queued_idx`) e sobrevive a qualquer reinício: o que estava em QUEUED continua lá.
- Com várias instâncias, cada reembolso é travado e o estado é conferido de novo antes de começar, então duas instâncias não começam o mesmo. O ritmo total pode passar do configurado (uma rodada por instância); para um limite global exato seria preciso um token bucket compartilhado, como o rate limit do gateway.
