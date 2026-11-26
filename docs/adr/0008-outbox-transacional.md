# 0008. Outbox transacional, publicado por polling

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Quando o order-service confirma um pedido, ele grava no Postgres e precisa publicar `OrderConfirmed` no Kafka. São dois sistemas sem transação em comum: gravar e depois publicar perde o evento se o serviço cair entre as duas coisas; publicar e depois gravar publica um fato que não aconteceu.

O documento deixava em aberto como publicar o outbox: um relay que consulta a tabela (polling) ou captura de mudanças com Debezium.

## Decisão

- **Outbox na mesma transação da mudança.** A mensagem (o envelope inteiro, com o `eventId`) entra na tabela `outbox` na transação que muda o estado. Ou as duas coisas ficam gravadas, ou nenhuma.
- **Relay por polling, uma instância por vez.** A cada 100 ms, o relay lê um lote de mensagens não publicadas em ordem de `id` (UUID v7), publica no Kafka, espera a confirmação de todas e só então as marca como publicadas. O lote é lido sob um advisory lock do Postgres, para que duas instâncias não publiquem lotes diferentes fora de ordem.
- **Ao menos uma vez:** se o serviço cair depois de publicar e antes de marcar, o lote sai de novo. Os consumidores ignoram mensagens repetidas pelo `eventId` (`processed_events`).
- **Trace contínuo:** o outbox guarda o `traceparent` de quem causou a mensagem, e o relay publica dentro desse contexto. O trace de um pedido atravessa o Kafka até o payment-mock e o inventory.
- **No inventory, o outbox é gravado por trigger.** O status de reservas e lotes muda em muitos lugares (dois motores de reserva, a projeção do stream do Redis, a abertura, a virada e a expiração). Um trigger por tabela grava o fato no outbox na mesma transação de qualquer mudança de status, então nenhum caminho esquece de publicar. O trigger das reservas é adiado até o commit, para enxergar os itens que a projeção grava depois da reserva.
- **No event-service**, o outbox fica no MongoDB, com transação no replica set (ADR 29).
- **Debezium fica de fora por enquanto:** traria o Kafka Connect e um conector por banco, e o polling com 100 ms já é rápido o bastante. É o passo natural se o volume crescer.

## Consequências

- Nenhum fato se perde nem é publicado sem ter acontecido, e a ordem por pedido e por show se mantém (cada pedido e cada lote é travado por quem o muda).
- A tabela `outbox` cresce; as mensagens publicadas podem ser apagadas depois de alguns dias (ainda não há job para isso).
- O polling custa uma consulta a cada 100 ms por serviço, barata com o índice parcial das mensagens não publicadas.
- Lógica no banco (os triggers do inventory) é menos visível que código Java. Os testes de contrato conferem cada fato gerado por eles contra o JSON Schema, nos dois motores.
- No inventory, o trace dos fatos começa no relay: o `traceparent` da transação só é informado quando a aplicação o define (`SET LOCAL lotou.traceparent`), o que ainda não acontece nos caminhos do Redis.
