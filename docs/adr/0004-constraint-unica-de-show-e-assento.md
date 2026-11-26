# 0004. Constraint única de show e assento nos ingressos

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Vender a mesma cadeira duas vezes é uma das duas falhas que o Lotou não pode ter. A primeira barreira é a reserva: o inventory-service só deixa uma reserva segurar cada cadeira (hoje com lock no Postgres; na fase 2, com `SET NX` no Redis).

A reserva e o ingresso, porém, moram em serviços diferentes. Entre uma e outro há um pagamento, chamadas de rede e, a partir da fase 2, um Redis que pode reiniciar. Um erro em qualquer ponto desse caminho (um bug na liberação de reserva, uma perda de dados no Redis, uma repetição mal tratada) poderia levar dois pedidos a emitir ingresso para a mesma cadeira.

A alternativa era confiar só na reserva.

## Decisão

O banco do order-service recusa o segundo ingresso. A tabela `tickets` tem um **índice único parcial**:

```sql
CREATE UNIQUE INDEX tickets_show_seat_uk ON tickets (show_id, sector_id, seat_label)
    WHERE seat_label IS NOT NULL AND status <> 'CANCELLED';
```

- Vale só para cadeira numerada (`seat_label` nulo é pista).
- O setor entra na chave porque o rótulo da cadeira (`A-12`) se repete entre setores.
- Ingresso cancelado sai do índice: a cadeira de um pedido reembolsado pode ser vendida de novo.

Quando o índice dispara, o order-service não confirma o pedido: desfaz a autorização do pagamento, cancela o pedido com o motivo `TICKET_CONFLICT` e registra um erro em log. Os ingressos do pedido são emitidos na mesma transação, então nenhum deles fica gravado.

## Consequências

- A invariante passa a ser garantida por quem grava o ingresso, não só por quem reserva. Nenhum caminho de código consegue emitir dois ingressos ativos para a mesma cadeira.
- É uma defesa que não deveria disparar. Se disparar, a reserva do inventory fica confirmada sem pedido correspondente, e isso precisa de tratamento manual. O log de erro é o gancho do alerta "venda além da capacidade" previsto na observabilidade.
- O teste `CheckoutRecoveryTests` provoca o conflito com um inventory de mentira, para a defesa ser exercitada de verdade.
- A pista não tem defesa equivalente por constraint no order-service (não há item único para indexar). Lá a última defesa é o `CHECK (available >= 0)` no contador do lote, no banco do inventory.
