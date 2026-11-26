# 0001. Kafka para eventos de domínio e comandos da saga

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

A partir da fase 3, os serviços deixam de se chamar por HTTP para tudo que não é o caminho do usuário (ADR 23). Os fatos de domínio (pedido criado, pagamento aprovado, lote esgotado) têm vários consumidores independentes: o order-service, o analytics, depois a portaria e as notificações. E os read models precisam ser reconstruídos do zero quando o código deles muda.

O RabbitMQ entrega cada mensagem a uma fila e a remove ao confirmar: bom para tarefas, ruim para fatos que vários serviços leem no seu próprio ritmo e que precisam ser relidos. O Redis Streams guarda mensagens, mas não foi feito para retenção longa nem para dezenas de consumidores (ADR 11).

## Decisão

- **Kafka carrega fatos de domínio e os comandos da saga.** RabbitMQ fica para tarefas com retry (fase 4), e o Redis para tempo real efêmero.
- Um broker em modo KRaft no Compose, sem ZooKeeper. Os tópicos são criados por um job (`kafka-init`) com partições e retenção definidas; a criação automática de tópicos fica desligada, para um nome digitado errado não virar um tópico novo.
- **A chave é o ID do agregado:** `orderId` nos tópicos do pedido, do pagamento e dos comandos; `showId` no catálogo e nos eventos do inventory. A ordem é garantida por pedido e por show.
- **Retenção por papel do tópico:**
  - `shows.catalog` é compactado: fica a última versão de cada show, e reler o tópico reconstrói o catálogo.
  - `order.events` e `inventory.events` não têm prazo: são a fonte do replay dos read models do analytics. O documento previa 7 dias para todos; com 7 dias, um replay só reconstruiria a última semana.
  - Comandos e respostas da saga ficam 7 dias: depois disso, ninguém mais precisa deles.
- Mensagens que falham depois das tentativas vão para `<tópico>.dlt`.
- O contexto do trace viaja no cabeçalho `traceparent`.

## Consequências

- Um consumidor novo (o analytics, depois a portaria) lê o histórico inteiro sem pedir nada a quem publicou.
- Os tópicos sem prazo crescem para sempre. Para um projeto deste tamanho é pouco; em produção, a saída seria compactar ou arquivar em armazenamento barato com snapshots dos read models.
- Um broker só não tem réplica: perder o volume do Kafka perde o histórico. Em produção seriam três brokers com `min.insync.replicas=2`.
- Cada linguagem precisa de um cliente Kafka: Spring Kafka no Java, `@confluentinc/kafka-javascript` no Node e `aiokafka` no Python.
