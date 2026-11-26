# 0022. Idempotency-Key do event-service no MongoDB

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

A convenção da API exige `Idempotency-Key` em todo POST que cria recurso. No event-service isso vale para criar local e criar show: um clique duplo, ou um retry depois de um timeout, não pode criar o mesmo show duas vezes. O seed também depende disso para poder rodar mais de uma vez.

O documento do projeto já define onde ficam as chaves do `POST /orders`: no `redis-core`, com `SET NX` e TTL de 24 h. Para o event-service, as alternativas eram:

1. **`redis-core`.** Mesmo mecanismo dos pedidos, mas o event-service passaria a depender de uma terceira base só para isso. Hoje ele usa o MongoDB e, a partir da fase 2, o `redis-cache`.
2. **`redis-cache`.** Já vai ser dependência do serviço, mas descarta chaves por LRU e não persiste. Perder uma chave de idempotência é criar um recurso duplicado.
3. **MongoDB**, na base do próprio serviço.

## Decisão

O event-service guarda as chaves **no MongoDB**, na coleção `idempotency_keys`:

- O `_id` é o SHA-256 de (usuário, rota, chave). O índice único do `_id` decide a corrida: de várias requisições simultâneas com a mesma chave, só uma consegue inserir e executar.
- O registro guarda o hash do corpo e, quando a requisição termina, a resposta. Uma repetição recebe a mesma resposta, com o cabeçalho `Idempotent-Replayed: true`.
- A mesma chave com outro corpo é 422. A mesma chave ainda em processamento é 409.
- Se a requisição falha, o registro é apagado e o cliente pode corrigir e repetir com a mesma chave.
- Um índice TTL apaga os registros depois de 24 h.
- Um registro em processamento há mais de 30 s é considerado abandonado (o processo caiu no meio) e pode ser assumido por uma repetição.

A chave vale por usuário e por rota, então dois usuários podem usar a mesma chave sem um ver a resposta do outro.

## Consequências

- O event-service não ganha uma dependência nova: a idempotência está na mesma base dos dados que ela protege.
- É uma escrita e uma atualização a mais por POST de criação. Essas rotas são do painel do produtor, de baixo volume. O caminho quente do comprador (`POST /orders`) continua no Redis, como o documento define.
- A gravação do recurso e a gravação da resposta não estão na mesma transação. Se o processo cair entre as duas, a repetição só é aceita depois de 30 s e executa de novo, o que pode duplicar o recurso. Fechar essa janela exigiria transações (MongoDB em replica set); fica aceito para rotas de cadastro e registrado aqui como limite conhecido.
- O mecanismo é diferente do usado em pedidos. A regra para o cliente é a mesma (cabeçalho, 24 h, mesma resposta na repetição); só muda onde o serviço guarda a chave.
