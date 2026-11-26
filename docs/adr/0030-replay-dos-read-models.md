# 0030. Replay dos read models em gerações, com troca atômica do ponteiro

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

O analytics-service monta read models no MongoDB (`sales_by_sector`, `producer_statements`, `order_view`, mais a cópia do catálogo e a linha do tempo dos lotes) a partir de `shows.catalog`, `order.events` e `inventory.events`. O critério da fase 3 é que um replay reconstrua esses read models. Ele é necessário sempre que a projeção muda (um campo novo, uma regra corrigida) ou que um read model se perde, e não pode tirar o painel do produtor do ar.

Três problemas precisavam de resposta:

1. **Entrega ao menos uma vez.** O Kafka entrega de novo o que não teve o offset confirmado. Um `$inc` aplicado duas vezes dobra a venda.
2. **Ordem parcial.** A ordem só é garantida por chave: tudo de um pedido chega em ordem, tudo de um show também, mas um pedido pode chegar antes do show (tópicos diferentes), e uma mensagem repetida pode chegar depois de outras.
3. **Replay sem parada.** Apagar as coleções e reler do começo deixa o painel vazio, ou com números parciais, até o fim da releitura.

As alternativas para o replay eram:

- **Apagar e reler no lugar.** Simples, mas o painel fica errado durante a releitura.
- **Reler para coleções novas e renomear no fim** (`renameCollection` com `dropTarget`). São cinco coleções; o MongoDB renomeia uma por vez, sem transação entre elas, e o consumidor ao vivo continua gravando nas antigas.
- **Gerações com ponteiro.** Coleções com o número da geração no nome, um documento que diz qual geração está ativa, e um consumer group por geração.

## Decisão

**Idempotência e ordem**

- Cada evento é aplicado numa transação do MongoDB (replica set `rs0`), junto com a gravação do `eventId` em `processed_events`. Repetição encontra o `eventId` e não faz nada. O offset só é confirmado depois da transação. Os `eventId` vencem em 30 dias (índice TTL): repetição do Kafka chega em minutos.
- Um lote de uma partição é uma transação só. Se o lote falha por erro da mensagem, as mensagens são reaplicadas uma a uma para isolar a culpada, que vai para `<tópico>.dlt` depois de `CONSUMER_MAX_ATTEMPTS` tentativas. Mensagem fora do contrato vai direto (repetir não muda o resultado). Falha de infraestrutura (MongoDB fora) nunca vai para a DLT: o consumidor espera e tenta de novo, e o lag sobe.
- Cada read model é uma função dos eventos, não da ordem de chegada nem do relógio:
  - o show guarda a `version` mais alta;
  - o pedido anda pela tabela de transições do pedido; um fato anterior que chega depois (`OrderCreated` depois do `OrderConfirmed`) só completa o documento, e uma transição fora da tabela é recusada e registrada em log;
  - vendas e contadores do relatório só somam, e só quando o pedido entra no estado, então nem um `OrderConfirmed` repetido com outro `eventId` conta duas vezes;
  - listas (linha do tempo do pedido e dos lotes) são ordenadas pela hora do fato.
- **Pedido antes do show:** o `order_view` nasce com `show: null` e é preenchido quando o show chega (e atualizado se o título, a data ou o local mudarem). Para essa cópia nunca ficar velha com duas instâncias consumindo, a transação que cria um `order_view` e a do catálogo gravam o mesmo documento (`producer_statements` do show); o MongoDB não deixa as duas passarem juntas, e a que perde repete com o estado novo. A ocupação não é copiada: é calculada na leitura com a capacidade do catálogo.

**Gerações**

- Uma geração é o par: coleções `<read model>_g<N>` e consumer group `analytics-service.gen-<N>`. O documento `analytics_state/active` aponta para a geração ativa; a API lê o ponteiro a cada requisição.
- Na primeira subida, a geração 1 é criada já ativa e lê os tópicos do começo.
- O replay (`POST /internal/v1/replay`, papel `service`, ou `python -m analytics.replay`):
  1. toma um lock com prazo no MongoDB (um replay por vez; lock vencido de um processo que morreu pode ser tomado) e reserva a geração N+1;
  2. guarda o fim de cada partição naquele instante (com `read_committed`, o último offset estável);
  3. consome do começo, com o consumer group da N+1, até alcançar esses offsets. A API continua lendo a N, e o consumidor ao vivo continua alimentando a N;
  4. confirma as posições no grupo da N+1, sai do grupo e troca o ponteiro numa transação que também confere o lock e aposenta a N;
  5. o supervisor de cada instância vê o ponteiro novo, para o consumidor da N e começa o da N+1, que continua exatamente de onde o replay parou;
  6. depois de uma carência (30 s), o supervisor apaga as coleções e o consumer group da N.
- Views com o nome sem sufixo (`order_view`, `sales_by_sector`, ...) apontam para a geração ativa, para quem lê o banco de fora (o producer-assistant na fase 5, o mongosh).
- Se o replay falha ou é interrompido, a N+1 fica FAILED e é apagada; a N segue ativa.

## Consequências

- O painel não para durante o replay: lê a geração antiga, completa, até a troca, e a nova a partir da requisição seguinte. O atraso entre a troca e o consumidor ao vivo passar para a geração nova é de até um intervalo de verificação (1 s); os eventos desse intervalo esperam no Kafka.
- O teste de integração prova o critério da fase: publica uma noite de vendas com repetições, mensagens inválidas e um pedido antes do show, dispara o replay, confere que a API respondeu durante a montagem e que a geração nova é igual à antiga documento a documento; outro teste roda o replay com eventos chegando e confere, com um segundo replay, que nada se perdeu nem foi contado duas vezes na troca.
- O nome do consumer group muda a cada replay (`analytics-service.gen-<N>`). Painéis e alertas de lag devem filtrar por prefixo.
- O replay ocupa o dobro do espaço dos read models enquanto roda, e relê tópicos sem prazo de retenção (ADR 1). Com o histórico crescendo, o tempo de replay cresce junto; a saída seria um snapshot periódico dos read models como ponto de partida.
- Uma mensagem que foi para a DLT vai de novo a cada replay, com o grupo da geração no cabeçalho `dlt.consumer.group`.
- A transação por lote e a leitura do documento antes de gravar custam mais que um `$inc` solto. Na escala do projeto não pesa; se pesar, o primeiro passo é processar partições em paralelo, que a ordem por chave permite.
