# 0002. RabbitMQ para gerar os ingressos e enviar os e-mails

- **Status:** aceita
- **Data:** 2026-11-27

## Contexto

Quando um pedido é confirmado, o order-service publica `TicketsIssued` em `order.events`, com o conteúdo do QR code de cada ingresso já assinado (ADR 15). Alguém precisa transformar isso em um PDF por pedido e mandar por e-mail ao comprador; um pedido cancelado também gera e-mail. São tarefas, não fatos: cada uma é feita uma vez, por um worker qualquer, e pode falhar por motivos passageiros (SMTP fora, Keycloak reiniciando, event-service lento).

O jeito mais curto seria tratar tudo dentro do consumidor do Kafka: ler o evento, gerar o PDF, mandar o e-mail e só então confirmar o offset. Isso tem quatro problemas:

1. **Retry com espera bloqueia a partição.** O Kafka confirma por offset, não por mensagem. Esperar 5 minutos para tentar de novo um e-mail parado segura todos os pedidos que vêm depois na mesma partição. Pular a mensagem exige uma fila de retry própria, que é reinventar o que o RabbitMQ já faz.
2. **A carga não se divide pelo trabalho.** O paralelismo do consumidor é o número de partições. Gerar PDF é CPU; mandar e-mail é espera de rede. As duas coisas precisam de quantidades diferentes de workers, e de poder subir mais workers de PDF sem repartir o tópico.
3. **Sem prioridade.** Numa abertura de vendas, o e-mail com o ingresso tem que passar na frente de um aviso de cancelamento (e, mais tarde, de marketing). O Kafka entrega na ordem do log.
4. **Sem uma DLQ por mensagem.** A DLT do Kafka (ADR 1) serve para mensagem fora do contrato. Um e-mail que falhou 4 vezes precisa ficar parado, visível, e voltar com um comando depois que a causa for corrigida.

## Decisão

**Kafka carrega o fato, RabbitMQ carrega a tarefa.** O notification-service consome `order.events` (consumer group `notification-service`, `read_committed`) e transforma `TicketsIssued` e `OrderCancelled` em tarefas no RabbitMQ. O resto do trabalho acontece nas filas.

**Topologia** (declarada pelo serviço ao subir, de forma idempotente):

| Exchange | Tipo | Routing key | Fila | Para quê |
| --- | --- | --- | --- | --- |
| `tickets` | direct | `render` | `tickets.render` | gerar o PDF; prefetch 1 por worker, `RENDER_WORKERS` workers, cada um num processo |
| `tickets.dlx` | fanout | — | `tickets.render.dlq` | PDF que não tem como sair (show que não existe, tarefa ilegível) |
| `notifications` | topic | `email.#` | `notifications.email` | enviar o e-mail; `x-max-priority` 10, prefetch 10, ack manual |
| `notifications.retry` | direct | `10s`, `1m`, `5m` | `notifications.retry.<chave>` | espera antes de tentar de novo |
| `notifications.dlx` | fanout | — | `notifications.email.dlq` | e-mail que falhou nas 4 tentativas |

A `tickets.render.dlq` não estava na tabela do documento: sem ela, um PDF impossível de gerar ficaria voltando para a fila para sempre.

**Entrega sem perda:** as filas são duráveis e as mensagens persistentes. Toda publicação espera a confirmação do broker (publisher confirms) antes de quem publicou confirmar o que consumiu: o offset do Kafka só é confirmado depois que o RabbitMQ aceitou a tarefa, e uma tarefa só recebe ack depois que a seguinte foi aceita. Isso substitui o outbox aqui: o serviço não tem banco, e o Kafka guarda o evento até a confirmação.

**Retry com TTL e dead-letter, contado no cabeçalho `x-attempt`:**

- a primeira entrega é a tentativa 1. Se falha, o worker republica a mensagem em `notifications.retry` com a chave da espera (`10s` na 1ª falha, `1m` na 2ª, `5m` na 3ª) e `x-attempt` + 1, espera a confirmação e dá ack na original;
- cada fila de retry tem `x-message-ttl` e `x-dead-letter-exchange: notifications`, sem routing key fixa. A mensagem é publicada com a chave da espera e, no cabeçalho `CC`, a chave do template (`email.ticket.issued`); ao vencer o TTL, ela volta a `notifications` com as duas chaves, e só a do template casa com `email.#`;
- se a 4ª tentativa falha, a mensagem vai para `notifications.dlx` com o motivo (`x-error`, sem e-mail), o número de tentativas e a hora; o alerta "DLQ" do documento dispara com `notifications_dlq_depth > 0`;
- o requeue (`POST /internal/v1/dlq/requeue` com papel `service`, ou `python -m notification.dlq requeue`) devolve as mensagens ao exchange de origem com `x-attempt: 1`, para uma nova rodada.

Os tempos de espera são configuráveis (`RETRY_DELAYS_SECONDS`), para os testes rodarem em segundos. Uma falha que repetir não resolve (tarefa ilegível) vai direto para a DLQ; comprador sem e-mail (as contas de serviço do smoke e da carga) é confirmado e contado, sem retry.

**Prioridade:** o e-mail do ingresso sai com prioridade 9 e o de cancelamento com 5, na fila com `x-max-priority` 10. Filas clássicas, porque as quorum queues têm só duas prioridades.

**Deduplicação no `redis-core`**, pelo `eventId` do Kafka, nunca por e-mail ou CPF: `notification:event:{eventId}` (o evento já virou tarefa) e `notification:email:{eventId}` (reserva antes de enviar, `sent` depois). Uma reentrega do Kafka ou um PDF gerado duas vezes não manda o segundo e-mail. Sem Redis, o fluxo segue sem deduplicação: um e-mail repetido é melhor que um ingresso que não chega.

**O e-mail do comprador vem do Keycloak, na hora de enviar.** Os eventos só levam o `buyerId` (o `sub` do token), e CPF e e-mail nunca entram em evento (contratos, ADR 28). O worker consulta `GET /admin/realms/lotou/users/{id}` com a conta de serviço `notification-service`, que tem só o papel `view-users` do `realm-management` e o escopo `kc-admin-api` (a audiência que a API de administração exige). O endereço fica em cache em memória por 5 minutos e não vai para log, span, cabeçalho nem chave do Redis.

**PDF fora do event loop:** o worker de PDF manda o trabalho para um pool de processos (`spawn`), um por consumidor de `tickets.render`. O QR code é desenhado em vetor com `segno` e `fpdf2`, bibliotecas Python sem serviço externo.

**Trace contínuo:** o `traceparent` vem do cabeçalho do Kafka e segue nos cabeçalhos AMQP (instrumentação do aio-pika); cada retentativa é filha da tentativa que falhou, então o trace mostra o caminho inteiro, do relay do order-service ao SMTP.

## Consequências

- Um e-mail parado não segura os outros: o retry acontece na fila de espera, e o consumidor do Kafka só publica tarefas, o que leva milissegundos.
- Com o serviço fora do ar, nada se perde: os eventos esperam no Kafka (offset não confirmado) e as tarefas esperam no RabbitMQ (duráveis). O teste de caos para o serviço, publica, sobe de novo e confere todos os e-mails.
- O RabbitMQ não aceita declarar de novo uma fila com outros argumentos: mudar o TTL de uma fila de retry num ambiente que já tem a fila exige apagá-la antes. As políticas do RabbitMQ resolveriam isso sem recriar a fila; com três filas fixas, não compensou.
- A entrega é ao menos uma vez. A janela que sobra para um e-mail repetido é uma queda entre o servidor SMTP aceitar e a marca `sent` no Redis.
- Mais um serviço de infraestrutura no Compose (RabbitMQ, com o painel de management) e o Mailpit para ver os e-mails em desenvolvimento.
- O serviço depende do Keycloak para enviar, não para receber: com o Keycloak fora, os e-mails esperam no retry e, se a queda passar de uns 6 minutos, na DLQ, de onde voltam com o requeue.
- Num cluster, as filas viram quorum queues (prioridade alta e normal) e os workers de PDF podem ir para um serviço separado, escalado pela profundidade de `tickets.render`.
