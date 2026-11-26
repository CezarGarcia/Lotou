# 0010. Duas instâncias de Redis

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

O Lotou usa o Redis para coisas de natureza oposta:

- **Cache** da página e da busca de shows: pode ser descartado a qualquer momento, porque o MongoDB tem o dado. Quando a memória enche, o certo é jogar fora o que é menos usado.
- **Estado de venda**: estoque dos lotes, cadeiras seguradas, cotas por CPF, fila virtual, reservas ativas e o stream para o Postgres. Descartar uma dessas chaves é um bug: venda além da capacidade, cadeira vendida duas vezes, gente perdendo o lugar na fila.

A política de memória do Redis vale para a instância inteira, não por chave.

## Decisão

Duas instâncias, com políticas opostas:

| Instância | Política | Persistência | Usada por |
| --- | --- | --- | --- |
| `redis-cache` | `allkeys-lru`, 256 MB | nenhuma | event-service (cache da página e da busca) |
| `redis-core` | `noeviction` | AOF a cada segundo | inventory (reserva, fila, mapa, stream), gateway e event-service (rate limit) |

- No `redis-core`, memória cheia faz o Redis recusar escritas em vez de descartar chaves. A reserva falha de forma visível, e o alerta de memória é que precisa disparar antes.
- Com AOF a cada segundo, um restart perde no máximo o último segundo. Como cada script grava a mudança e a entrada do stream na mesma operação, o que se perde se perde junto, e o Postgres continua coerente com o que sobrou (ADR 26).
- O rate limit fica no `redis-core`: um balde que some no meio de uma rajada deixaria passar o que devia barrar.

## Consequências

- Um pico de cache não empurra o estoque para fora da memória, e um cache que cresce sem controle não derruba a venda.
- São dois processos para operar e monitorar, com métricas separadas de memória e de evictions. Em produção podem ter tamanhos e réplicas diferentes.
- O event-service fala com as duas instâncias, cada uma para uma coisa.
