# 0003. Reserva com script Lua no Redis, comparada ao lock no Postgres

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Na abertura das vendas, milhares de compradores disputam os mesmos ingressos no mesmo segundo. A fase 1 reserva com lock no Postgres: `SELECT ... FOR UPDATE` na linha do lote (pista) ou nas linhas das cadeiras (lugar marcado), tudo numa transação. É correto, mas cada reserva de um mesmo lote espera a anterior soltar a linha. A linha do lote vira uma fila, e quem está na fila segura uma conexão do pool enquanto espera.

A alternativa é tirar a disputa do banco: um script Lua no `redis-core`, que o Redis executa inteiro sem intercalar outro comando. Sem lock, sem transação e sem ida e volta entre a leitura e a escrita.

## Decisão

A reserva é um script Lua (`reserve.lua`) que, numa operação atômica:

1. devolve a reserva já feita se a `Idempotency-Key` se repete;
2. confere se o estoque do show está carregado, o token da fila (em show de alta demanda), a cota do CPF e o status do lote;
3. na pista, confere e decrementa o contador do lote; na cadeira numerada, confere que todas as cadeiras escolhidas estão livres e segura todas, ou nenhuma;
4. grava a reserva, a cota e o bitmap do mapa, vira o lote se ele zerou, grava tudo no stream que alimenta o Postgres (ADR 26) e avisa quem está com o mapa aberto (ADR 11).

Confirmar, liberar, expirar, virar o lote, pausar e encerrar também são scripts, para que nenhuma mudança de estoque aconteça fora do Redis durante a venda.

O motor do Postgres da fase 1 continua no código, escolhido por `RESERVATION_ENGINE=postgres`. Os dois passam pelos mesmos testes (cada cenário de concorrência, ciclo de vida, API e virada de lote roda contra os dois motores) e pelo mesmo teste de carga, que confere as invariantes no Postgres no fim.

## Resultado medido

k6 contra o inventory-service, ambiente recriado do zero antes de cada motor. Tudo numa máquina só de 4 CPUs e 16 GB: os onze containers do Lotou, os bancos, o Grafana e o próprio k6. Os números absolutos dizem pouco sobre produção; a comparação entre os motores é o que vale.

**Abertura de vendas** (`make load-opening`): 2.000 usuários virtuais durante 40 s, cada um tentando reservar sem parar, para 2.000 ingressos de pista e 500 cadeiras.

| | Redis + Lua | Postgres + `FOR UPDATE` |
| --- | --- | --- |
| Tentativas de reserva respondidas | 78.621 | 19.415 |
| Ingressos reservados | 2.500 de 2.500 | 2.481 de 2.500 |
| Latência p50 / p95 / p99 | 714 ms / 2,43 s / 2,98 s | 2,81 s / 14,0 s / 20,5 s |
| Respostas inesperadas (erro ou timeout) | 0 | 18 |
| Venda além da capacidade | 0 | 0 |

**Disputa por cadeira** (`make load-contention`): 1.000 compradores ao mesmo tempo pelas mesmas 50 cadeiras.

| | Redis + Lua | Postgres + `FOR UPDATE` |
| --- | --- | --- |
| Latência p50 / p99 | 223 ms / 283 ms | 1,40 s / 1,95 s |
| Cadeira vendida duas vezes | 0 | 0 |

O Redis respondeu quatro vezes mais tentativas na abertura, com p99 sete vezes menor, e terminou de vender o estoque inteiro. No Postgres, as conexões ficaram presas esperando o lock: 18 requisições estouraram o timeout do pool, e 19 ingressos não chegaram a ser vendidos nos 40 s. Os dois motores mantiveram as invariantes: nenhum lote vendido além da quantidade, nenhuma cadeira vendida duas vezes e o contador de cada setor igual ao que foi reservado.

A meta do documento, p99 da reserva abaixo de 50 ms, não foi atingida nesta máquina com 2.000 usuários simultâneos. A latência é fila de CPU: o k6 e o serviço disputam os mesmos 4 núcleos. Com a fila virtual ligada, o checkout recebe só N pessoas por segundo (ADR 13), e é ela que mantém a latência da reserva baixa num show de verdade.

## Consequências

- A disputa sai do banco: o Postgres recebe as reservas já decididas, em lote, pelo stream.
- O Redis passa a ser a fonte da verdade durante a venda, com tudo o que isso pede: persistência, reconciliação, nada expirando por TTL (ADR 26) e uma instância separada do cache (ADR 10).
- As regras de negócio da reserva existem duas vezes, em Java e em Lua. Os testes em comum dos dois motores são o que impede que divirjam.
- A constraint única de cadeira nos ingressos continua como última defesa (ADR 4).
