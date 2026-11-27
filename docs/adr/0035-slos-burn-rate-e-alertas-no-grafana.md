# 0035. SLOs com burn rate, alertas no Grafana e invariantes consultadas nos bancos

- **Status:** aceita
- **Data:** 2026-11-27

## Contexto

O documento lista oito alertas (seção "Alertas"): as duas invariantes do sistema (venda além da capacidade e entrada dupla), o SLO do checkout, a portaria lenta, o lag de consumidor, a DLQ, a saga presa e o reembolso que falhou. Faltava decidir onde eles vivem, como chegam a alguém e como medir o SLO sem alertar em ruído.

Alguns alertas dependem de métricas (latência, erros, lag, filas). As invariantes, não: uma métrica emitida pelo próprio serviço que vende o ingresso diria só o que o serviço acha que fez. A fonte da verdade é o banco.

## Decisão

- **Alertas no Grafana**, provisionados por arquivo (`infra/grafana/provisioning/alerting/lotou.yaml`), avaliados a cada minuto. O contato é um e-mail para `plantao@lotou.test`, que chega ao Mailpit do Compose. Sem Alertmanager separado: o `grafana/otel-lgtm` já traz o Grafana, e as regras gerenciadas por ele consultam qualquer fonte de dados.
- **Invariantes consultadas nos bancos**, com um usuário só de leitura (`observer`, com `pg_monitor` e `pg_read_all_data`): lote ou setor com mais reservas ativas que ingressos e cadeira em duas reservas (inventory), dois check-ins do mesmo ingresso (checkin), pedido em PENDING há mais de 15 minutos e pedido em REFUND\_FAILED (orders). São as mesmas consultas do `make load-check`.
- **SLO do checkout:** 99,5% das reservas e dos pedidos (rotas `reserve` e `place-order` do gateway) sem resposta 5xx, em 30 dias. O orçamento de erro é 0,5%. Respostas 4xx (cupom inválido, reserva expirada, rate limit) são o sistema funcionando e não contam.
- **SLO de latência do checkout:** 99% das reservas e dos pedidos respondidos em menos de 1 s, em 30 dias (orçamento de 1%), medido pelo histograma do gateway (bucket de 1 s). Ele nasceu do experimento de caos com o Postgres lento: com 500 ms em cada consulta, o pedido levou 8 s e nenhum deu erro, e o SLO de disponibilidade sozinho não perceberia.
- **Burn rate em janelas múltiplas**, nos dois SLOs, como no livro de SRE do Google: alerta crítico quando o consumo passa de 14,4 vezes o aceitável em 1 hora **e** em 5 minutos (2% do orçamento do mês numa hora), e alerta alto com 6 vezes em 6 horas e 30 minutos. A janela curta faz o alerta parar logo que o problema para; a longa evita alertar num pico de segundos.
- **Portaria lenta** é um alerta de limite simples (p99 do check-in acima de 200 ms por 5 minutos), porque a meta da portaria é de latência, não de disponibilidade.
- Alerta sem dados fica OK: sem tráfego não há erro a contar.

## Alternativas consideradas

- **Regras no Prometheus com Alertmanager.** Mais comum em produção, mas exigiria mais dois componentes no Compose e não consulta o Postgres; as invariantes precisariam de um exporter de SQL.
- **Uma métrica de invariante emitida pelos serviços.** Mais barata de consultar, mas é o serviço avaliando a si mesmo; o objetivo do alerta é pegar justamente o caso em que o serviço errou.
- **Alertar em taxa de erro fixa (por exemplo, 5% em 5 minutos).** Dispara em picos curtos e não diz quanto do orçamento foi gasto.

## Consequências

- Os alertas chegam ao Mailpit e cada um aponta o dashboard que ajuda a investigar.
- As consultas SQL rodam a cada minuto nos bancos dos serviços. São pequenas (índices de status e chaves estrangeiras), mas num ambiente grande teriam de ir para uma réplica de leitura.
- Os SLOs são medidos no gateway, então contam só o que o comprador vê; um erro interno recuperado pela saga não gasta orçamento.
- A latência do pedido no SLO é a da resposta do `POST /orders` (o pedido PENDING); o tempo da saga, assíncrono, fica no dashboard de negócio (`saga_duration_seconds`).
