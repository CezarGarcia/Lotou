# 0014. Portaria com cópia local dos ingressos

- **Status:** aceita
- **Data:** 2026-11-27

## Contexto

No dia do show, a portaria lê milhares de QR codes em poucas horas, a maior parte na meia hora antes do início. A meta é ler cada um em menos de 200 ms (p99), e nenhum ingresso pode liberar duas entradas, nem quando dois portões leem o mesmo QR (um print repassado) no mesmo segundo.

Quem emite os ingressos é o order-service. A forma mais simples seria a portaria perguntar a ele a cada leitura. Mas aí a fila na porta dependeria do order-service, do banco dele e da rede entre os dois, e o experimento de caos "order-service fora do ar no dia do show" pararia o show. O order-service também não foi feito para essa carga: a dele é a da venda, semanas antes.

Alternativas consideradas:

- **Consultar o order-service a cada leitura** (com cache): acopla a portaria à disponibilidade dele, e o cache só adia o problema (um ingresso cancelado continuaria entrando até o cache vencer).
- **Ler o banco do order-service:** fere o "um banco por serviço" (ADR 18).
- **Cópia local alimentada por eventos:** a portaria guarda o que precisa e não pergunta nada a ninguém na hora da leitura.

## Decisão

- **Cópia local alimentada pelo Kafka.** O checkin-service consome `order.events` (grupo `checkin-service`, desde o começo do tópico, `read_committed`): `TicketsIssued` grava os ingressos em `valid_tickets` como `VALID`; `TicketsCancelled` os marca `CANCELLED`, sem apagar, para o leitor dizer "cancelado" (vermelho) em vez de "desconhecido". Cada mensagem é aplicada numa transação com o `eventId` em `processed_events`. Do `shows.catalog` vem uma cópia mínima dos shows (horário, abertura dos portões, fuso, local, produtor), com a versão mais alta de cada um.
- **Estados do ingresso numa tabela única:** `VALID` → `USED` (entrada) e `VALID` → `CANCELLED`. Um `TicketsCancelled` que chega para um ingresso já usado não o muda (a transição está fora da tabela); os outros ingressos do pedido são cancelados normalmente.
- **Assinatura antes do banco.** O QR é `LOTOU1.<ticketId>.<HMAC>` (ADR 15). A portaria confere o HMAC com a mesma chave do order-service, em tempo constante, antes de qualquer consulta: um código falsificado ou malformado é `INVALID_CODE` sem tocar no Postgres. Por isso as recusas são gravadas em lote, fora da requisição: a cada 200 ms, uma transação grava as linhas de `checkin_rejections` (para o resumo da portaria) e os `CheckinRejected` no outbox.
- **Uma leitura válida é uma consulta pela chave primária**, que traz o ingresso, o horário do show e a entrada, se já houver. Na ordem: desconhecido, de outro show, cancelado, já usado, antes da abertura dos portões (`doorsOpenAt`; sem ele, o começo do dia do show no fuso do local).
- **Corrida entre portões: Redis primeiro, constraint por último.** Um `SET NX` em `checkin:{ticketId}` no `redis-core`, com o horário e o portão no valor, decide quem chega primeiro sem esperar o banco; os outros portões recebem `ALREADY_USED` com esse horário e esse portão. Quem ganha grava a entrada em `checkins` e o `TicketCheckedIn` no outbox, na mesma transação. A palavra final é a constraint única de `checkins.ticket_id` (`INSERT ... ON CONFLICT DO NOTHING`): com o Redis fora, lento ou sem os dados, a leitura segue direto para o banco, e a constraint sozinha deixa uma entrada só.
- **Marca do Redis sem entrada no banco:** se quem marcou falha ao gravar, a marca é desfeita; se o processo cai entre o Redis e o banco, a marca fica, mas uma marca com mais de 5 segundos de um ingresso que o banco ainda diz `VALID` não vale mais, e a leitura segue pelo banco.
- **O serviço está pronto (`/health/ready`) se o Postgres responde.** Sem o Kafka, as entradas esperam no outbox; sem o Redis, a constraint decide.

## Consequências

- A portaria funciona com o order-service fora do ar, e a leitura não depende de nenhuma chamada a outro serviço. Medido nos testes de integração, pela API com token, em 200 leituras seguidas: p99 entre 15 e 40 ms, numa máquina dividida com outros testes.
- A cópia fica atrás do order-service pelo atraso do consumidor. Um ingresso emitido segundos antes da leitura pode ainda não ter chegado (`UNKNOWN_TICKET`, e o comprador lê de novo); um cancelamento de última hora pode chegar depois da entrada. O lag do grupo `checkin-service` entra no painel de mensageria.
- Um grupo novo relê `order.events` inteiro, que não tem prazo de retenção. Para uma portaria com anos de histórico, a releitura fica longa; aí vale filtrar só os shows dos próximos dias ou guardar um snapshot.
- As recusas podem se perder se o processo cair (as dos últimos 200 ms, no máximo). Uma recusa não muda estado nenhum; a entrada liberada, que muda, é gravada na hora, junto com o evento dela.
- O Redis guarda só o caminho rápido: perder os dados dele não libera uma segunda entrada, porque o ingresso já está `USED` na cópia local e a constraint continua lá.
- **Questão em aberto: portaria sem internet.** O leitor ainda depende da rede até o checkin-service. Um leitor offline teria de levar a lista de ingressos do show e a chave do HMAC (ou uma chave pública, trocando o HMAC por assinatura assimétrica), registrar as entradas localmente e sincronizar depois, aceitando que dois leitores offline podem liberar o mesmo QR. Fica para depois da fase 6.
