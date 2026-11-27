# 0033. Uso do cupom contado no Postgres, na transação do pedido

- **Status:** aceita
- **Data:** 2026-11-27

## Contexto

O documento previa contar os usos de cada cupom num script Lua no `redis-core` (`coupon:{code}:uses`), que recusa acima do limite. Na abertura de um show com cupom de lançamento, muitos compradores podem disputar os últimos usos ao mesmo tempo, e o limite não pode ser ultrapassado nem por um.

O cupom é aplicado quando o pedido é criado, no order-service, que guarda pedidos no Postgres. Contar o uso no Redis faria o pedido e o uso morarem em dois sistemas: se o pedido falhasse depois de o Redis contar, o uso ficaria preso; se o Redis caísse depois de contar e antes de persistir, o uso se perderia. Seria preciso um outbox ou uma reconciliação só para isso.

## Decisão

- O uso é contado no **Postgres do order-service, na mesma transação que cria o pedido**, com um update condicional: `UPDATE coupons SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND status = 'ACTIVE' AND valid_until > now()`. Se nenhuma linha muda, o cupom esgotou (ou venceu) e o pedido é recusado com `coupon-invalid`.
- O uso volta (`uses - 1`) na mesma transação em que o pedido é cancelado ou reembolsado, com a saga.
- `coupon_redemptions` guarda um registro por pedido (constraint única), para o relatório de desempenho do cupom e para a devolução ser idempotente.
- O `redis-core` continua sem chave de cupom.

## Consequências

- O limite é exato mesmo sob disputa: o update condicional trava a linha do cupom, e só quem conseguir incrementar dentro do limite cria o pedido. O teste de carga da fase 7 ("cupom com limite de 100 usos disputado por mil compradores") mede isso.
- A linha do cupom vira um ponto quente sob disputa, como o lote era na fase 1 (ADR 3). Para um cupom isso é aceitável: o pedido já é limitado pela reserva, que acontece antes, no Redis, e a fila virtual controla quantos chegam ao checkout.
- Uma coisa a menos no Redis e nenhuma reconciliação entre dois sistemas.
