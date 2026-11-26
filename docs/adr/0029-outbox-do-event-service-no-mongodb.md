# 0029. Outbox transacional do event-service no MongoDB

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Na fase 3, o catálogo passa a chegar aos outros serviços pelo tópico `shows.catalog` (ADR 1), no lugar do polling da API interna (ADR 23). Toda mudança de um show publicado (edição do produtor, abertura e encerramento das vendas, nome do local) precisa virar uma mensagem com o show inteiro e uma `version` que só cresce, e o tópico é compactado: a última mensagem de cada show é a que fica.

O problema é gravar no MongoDB e publicar no Kafka sem perder nem inverter nada. As alternativas eram:

1. **Escrita dupla:** gravar o show e, em seguida, publicar. Se o processo cair entre as duas, a mudança fica no banco e nunca chega ao tópico; se o Kafka estiver fora, ou a escrita falha (o Kafka derruba o painel do produtor) ou a mensagem se perde. Duas instâncias publicando ao mesmo tempo também podem inverter a ordem de duas versões do mesmo show.
2. **Change streams do MongoDB:** um processo lê o oplog e publica cada mudança da coleção `events`. Não exige transação, mas o evento sai da forma do documento, não de uma decisão de domínio: é preciso deduzir `ShowPublished` ou `ShowUpdated` olhando o antes e o depois, filtrar rascunhos e campos internos, e guardar o resume token em algum lugar. O trace da requisição se perde, porque o oplog não carrega o `traceparent`, e o histórico do oplog é limitado: um leitor parado por tempo demais perde o ponto onde estava.
3. **Outbox transacional:** gravar o show e a mensagem pronta numa coleção `outbox`, na mesma transação, e um relay publica depois.

## Decisão

- **Outbox na base do próprio event-service.** Toda escrita que muda um show fora do rascunho (`publish`, `update`, o job de abertura e encerramento das vendas, e a cópia de nome e endereço do local para os shows) grava, na mesma transação do MongoDB, o show com `version` incrementada e um documento em `outbox` com o envelope pronto, a chave (`showId`), a versão e o `traceparent` de quem fez a mudança. O MongoDB roda como replica set de um nó (`rs0`), o que libera transações.
- **Um relay por vez, com lease.** Só a instância dona de um lease em `outbox_leases` publica. O lease é tomado e renovado com um único `findOneAndUpdate`, comparando com a hora do próprio MongoDB (`$$NOW`), e vale 10 s; a cada troca de dono sobe um `term`.
- **Fencing pelo Kafka.** Um lease não impede que uma instância que travou (pausa de GC, rede) acorde depois do prazo e publique um lote velho por cima de um novo. Por isso o produtor do relay é transacional, com o mesmo `transactional.id` em todas as instâncias: quando a nova dona conecta, o broker aborta a transação aberta da anterior e recusa tudo o que ela tentar publicar depois. Cada lote é uma transação do Kafka.
- **Ordem por show.** Dentro de uma chave, o relay publica em ordem crescente de versão e nunca publica uma versão menor que a última já publicada daquela chave; uma assim é só marcada. As publicadas ficam 7 dias no outbox (índice TTL), o que guarda essa última versão.
- **Pelo menos uma vez.** O relay marca as mensagens depois do commit no Kafka. Se cair entre os dois, o lote sai de novo, inteiro e na mesma ordem; o consumidor guarda a versão mais alta de cada show e ignora a repetição.
- O relay continua o trace: o `traceparent` guardado é o pai do span de produtor, e o contexto desse span vai no cabeçalho da mensagem.

## Consequências

- Nenhuma mudança se perde: se a transação confirma, a mensagem existe; se o Kafka está fora, o painel do produtor continua funcionando e o outbox acumula. O atraso aparece em `outbox_oldest_pending_age_seconds`.
- O evento é decidido pelo domínio, no ponto da escrita: rascunho nunca sai, o tipo (`ShowPublished` ou `ShowUpdated`) é explícito e o payload segue o contrato, sem campos internos.
- A última mensagem de cada show no tópico compactado é sempre a de versão mais alta, mesmo com duas instâncias, quedas no meio do lote ou uma instância zumbi.
- Cada escrita de show vira uma transação com duas gravações, e o relay faz algumas leituras por rodada (a cada 500 ms) mesmo sem nada pendente. Para o volume do painel do produtor, é pouco.
- Só uma instância publica por vez. O catálogo muda pouco; se um dia o volume pedir, o lease pode ser dividido por faixa de chaves.
- Os consumidores devem ler com `isolation.level=read_committed`, para não verem os lotes abortados por fencing ou por queda (o padrão do cliente do Node; no Spring Kafka, é preciso configurar). Mesmo lendo sem isso, a ordem por show vale: o que o zumbi gravou antes do fencing fica antes do que a nova dona publica.
- O MongoDB passa a exigir replica set em todo ambiente, inclusive nos testes. Do host, a conexão com o Compose precisa de `directConnection=true`, porque o membro se anuncia como `mongodb:27017`.
- Com transações disponíveis, a janela registrada no ADR 22 (a gravação do recurso e a da resposta da `Idempotency-Key` em operações separadas) pode ser fechada da mesma forma.
