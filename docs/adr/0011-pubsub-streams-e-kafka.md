# 0011. Pub/sub para o mapa, Streams para as reservas, Kafka para fatos de domínio

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Na fase 2 aparecem as primeiras mensagens entre partes do sistema: avisar quem está com o mapa aberto que uma cadeira foi segurada, e levar ao Postgres o que o script de reserva mudou no Redis. Na fase 3 entra o Kafka. Era preciso escolher, para cada fluxo, o mecanismo que dá a garantia certa e nada além.

| | Pub/sub do Redis | Redis Streams | Kafka |
| --- | --- | --- | --- |
| Guarda a mensagem? | não: quem não está ouvindo perde | sim, até ser aparada | sim, por dias |
| Confirmação de leitura | não | sim (`XACK`), com reentrega (`XPENDING`, `XCLAIM`) | sim (offsets) |
| Atômico com a mudança no Redis | sim (dentro do script) | sim (dentro do script) | não |
| Vários consumidores independentes, replay | não | limitado | sim |

## Decisão

- **Mapa de assentos: pub/sub** (`seatmap.{showId}`). Perder uma mensagem não importa: o navegador lê o bitmap ao conectar, e a próxima leitura corrige qualquer diferença. Guardar essas mensagens seria custo sem benefício.
- **Reservas a gravar no Postgres: Redis Stream** (`stream:reservations`) com consumer group. Não pode perder nada, e precisa ser escrito **na mesma operação atômica** que muda o estoque: só o Redis dá isso, porque o `XADD` acontece dentro do script Lua. Com o Kafka, a reserva e a mensagem seriam duas escritas separadas, que é exatamente o problema que o outbox resolve no order-service.
- **Fatos de domínio entre serviços: Kafka** (fase 3). Vários consumidores independentes, replay para reconstruir read models e retenção de dias, coisas que o Stream não dá bem.
- **Métricas do painel ao vivo: pub/sub**, e o **feed de atividade: Stream** (fase 4), pelos mesmos critérios.

## Consequências

- O stream de reservas é aparado só até a entrada mais antiga que ainda não chegou ao Postgres (`XTRIM MINID`), em vez de um `MAXLEN` fixo: um limite por tamanho descartaria entradas não gravadas num pico.
- O consumer group grava no Postgres com garantia de ao menos uma vez. Cada entrada leva o estado final do que mudou e a posição no stream, então reaplicar ou aplicar fora de ordem não estraga nada (ADR 26).
- Três mecanismos de mensagem no mesmo sistema exigem que cada um tenha um motivo claro, e este ADR é esse motivo.
