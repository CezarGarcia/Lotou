# 0026. Redis como fonte da verdade durante a venda, com o Postgres alimentado por stream

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

A fase 2 troca a reserva com lock no Postgres por um script Lua no `redis-core` (ADR 3). Isso levanta a pergunta que o documento deixava em aberto: com o estoque no Redis, qual é a fonte da verdade, e como o Postgres (que guarda as reservas para o pedido, o reembolso e o relatório) fica sabendo?

As alternativas eram:

1. **Escrever no Redis e no Postgres na mesma requisição.** São duas escritas sem transação entre elas: se a segunda falhar, os dois divergem. E o Postgres volta a ser o gargalo que a fase 2 quer tirar do caminho.
2. **Redis só como cache do Postgres.** Não resolve a disputa: o lock continuaria no banco.
3. **Redis como fonte da verdade durante a venda, Postgres como cópia durável**, alimentada por um stream escrito na mesma operação atômica da reserva.

## Decisão

Opção 3 (write-behind por stream):

- **Durante a venda, o Redis decide.** Reservar, confirmar, liberar, expirar, virar lote, pausar e encerrar são scripts Lua. Cada um confere tudo antes de mudar qualquer coisa, e grava a mudança em `stream:reservations` na mesma operação.
- **O Postgres é a cópia durável.** Um consumer group aplica o stream numa transação por lote e só então confirma (`XACK`). Entradas de uma instância que caiu são assumidas por outra (`XPENDING` + `XCLAIM`).
- **Cada entrada leva o estado final, não a diferença:** o contador do lote, o status da cadeira, a cota do CPF e a reserva inteira, com a posição da entrada no stream. Cada linha guarda essa posição (`redis_seq`) e uma entrada mais antiga nunca sobrescreve uma mais nova. Aplicar de novo, ou fora de ordem, não muda o resultado.
- **Nada expira sozinho no Redis enquanto a reserva está ativa.** Cadeira segurada e reserva ativa não têm TTL (o documento previa 10 minutos). Uma cadeira que se soltasse sozinha deixaria o contador e a cota para trás. A expiração é feita pelo job que varre o Postgres, pelo mesmo script que devolve tudo junto. Concluída, a reserva fica um dia no Redis.
- **Reconciliação:** a carga do estoque, na abertura, copia o estado do Postgres para o Redis e grava uma marca (`show:{id}`) por último. Se o Redis perder os dados de um show com as vendas abertas, o job vê a marca sumir e carrega de novo. Isso responde à questão em aberto do documento sobre perda do Redis.
- **Leituras:** disponibilidade e mapa vêm do Redis. A consulta de uma reserva lê o hash do Redis enquanto ele existe e o Postgres depois.
- **Tempo real na fase 2:** como o inventory é o dono da fila e do mapa, ele mesmo serve os fluxos SSE da posição na fila e do mapa de assentos. Na fase 4 esses fluxos passam pelo analytics-service, o hub de tempo real.

## Consequências

- A reserva não toca no Postgres. No teste de carga, o motor Redis respondeu 4 vezes mais rápido na disputa por cadeira e processou o dobro de requisições na abertura (ADR 3).
- O Postgres fica alguns milissegundos atrás do Redis; sob carga extrema, alguns segundos. Quem lê o Postgres (o job de expiração, a conferência de invariantes) tolera isso.
- **O que se perde num restart do Redis sem AOF:** reservas do último segundo que ainda não chegaram ao Postgres. O comprador recebeu o ID de uma reserva que não existe mais, e o pedido dela falha com "reserva não encontrada". O estoque não fica inconsistente, porque a mudança e a entrada do stream se perdem juntas.
- **O motor é escolhido por implantação.** Trocar de motor com reservas ativas não é suportado: o motor Postgres expiraria reservas sem devolver os ingressos ao contador do Redis. O teste de carga recria o ambiente antes de trocar de motor.
- Os scripts montam os nomes das chaves a partir dos IDs, o que funciona num Redis standalone. Um Redis Cluster pediria hash tags (`{showId}`) nas chaves de um show.
- O motor Postgres da fase 1 continua no código, com os mesmos testes, como linha de base do ADR 3.
