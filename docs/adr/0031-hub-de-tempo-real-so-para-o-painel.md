# 0031. O analytics é o hub de tempo real do painel; o SSE da loja fica no inventory

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

O documento previa que, na fase 4, todos os fluxos de tempo real passariam pelo analytics-service: o painel do produtor (WebSocket) e também os da loja (SSE da posição na fila e do mapa de assentos), que o inventory serve desde a fase 2 (ADR 26).

Mover os fluxos da loja para o analytics faria o analytics ler o estado da fila e o bitmap de assentos no `redis-core` com o formato de chaves do inventory, ou pedir ao inventory a foto do mapa por HTTP a cada conexão. Nos dois casos, o analytics passaria a depender do modelo interno de outro serviço (ADR 18), só para repassar dados que o inventory já entrega.

## Decisão

- **O analytics é o hub do painel do produtor:** métricas a cada segundo e feed de atividade, por WebSocket, a partir dos eventos do Kafka que ele já consome.
- **A posição na fila e o mapa de assentos continuam no inventory**, que é o dono desses dados e já os serve por SSE.
- As métricas do painel saem do analytics no pub/sub `dashboard.metrics:{showId}`, a cada segundo, e a atividade no Redis Stream `stream:activity:{showId}`; cada instância do analytics lê os dois e repassa aos produtores conectados a ela (ADR 11).

## Consequências

- Nenhum serviço lê o estado de outro: cada fluxo de tempo real sai de quem tem o dado.
- O tempo real fica em dois serviços. Com mais fluxos para a loja (o pedido sendo processado, por exemplo), vale reavaliar um gateway de tempo real dedicado.
- O `docs/projeto.md` foi atualizado: o mapa e a fila não passam pelo analytics.
