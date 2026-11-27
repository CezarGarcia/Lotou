# Testes de carga

Os cenários da tabela "Carga (k6)" do [documento do projeto](../docs/projeto.md#carga-k6). O k6 roda como serviço `k6` do Compose (profile `load`), na mesma rede dos serviços, e manda as métricas ao Prometheus do `lgtm` por remote write: cada rodada aparece no Grafana junto com as métricas dos serviços.

Todo cenário segue o mesmo desenho:

- o `setup` cria os próprios dados pela API (um show novo, como o produtor faria, com a conta de serviço `lotou-seed`), sem depender do `make seed`;
- o comprador e a portaria são a conta de serviço `lotou-smoke` (client credentials), que compra sem e-mail: o notification-service gera o PDF, mas não envia nada;
- as chamadas vão direto aos serviços (`inventory-service:8082`, `order-service:8083`, `checkin-service:3003`), sem o rate limit por usuário do gateway; os serviços revalidam o token (ADR 21);
- os thresholds do k6 dizem se a rodada passou, e no fim uma consulta ao banco confere as invariantes.

| Comando | Cenário | Script |
| --- | --- | --- |
| `make load-opening` | abertura de vendas (`ENGINE=redis\|postgres`) | `reservation-opening.js` |
| `make load-contention` | mil compradores pelas mesmas 50 cadeiras | `seat-contention.js` |
| `make load-show-page` | página do show com e sem cache | `show-page.js` |
| `make load-check` | invariantes de venda no banco inventory | `check-invariants.sql` |
| `make load-gate-prepare` + `make load-gate` | portaria: 30 mil check-ins em 10 portões | `gate-prepare.js`, `gate.js`, `gate.sh`, `check-gate.sql` |
| `make load-coupon` | cupom de 100 usos disputado por mil compradores | `coupon.js`, `check-coupon.sql` |
| `make load-consumer-lag` | pico de pedidos com o analytics-service parado | `consumer-lag.js`, `consumer-lag.sh`, `check-consumer-lag.sql` |
| `make load-render` | geração dos ingressos com 1, 2 e 4 workers | `ticket-render.js`, `render.sh` |

Os números abaixo vêm de uma máquina de 4 CPUs e 15 GB, com o ambiente inteiro e o k6 disputando os mesmos núcleos. Servem para comparar e para provar as invariantes; o valor absoluto muda de máquina para máquina.

## Portaria

**Prova:** nenhuma entrada dupla (cada ingresso entra uma vez só, e as leituras repetidas respondem `ALREADY_USED`) e o p99 do `POST /v1/checkins` abaixo de 200 ms, a meta do alerta "Portaria lenta".

```bash
make load-gate-prepare        # compra os ingressos (uns 8 minutos para 30 mil)
make load-gate                # 30 mil check-ins, 1.500 leituras repetidas, e confere no banco
```

O cenário tem duas etapas porque os ingressos precisam existir de verdade na cópia local do checkin-service, que vem do `TicketsIssued` do order-service (ADR 14). O preparo cria um show "Teste de carga: portaria" com 100 mil lugares na pista, os portões abertos há uma hora e o começo daqui a 6 dias, e compra pedidos de 4 ingressos de pista, cada um com um CPF novo, pela saga inteira. Depois espera a cópia local chegar e a fila `tickets.render` esvaziar (um PDF por pedido), para a rodada não disputar CPU com a geração dos ingressos.

O preparo serve para várias rodadas: cada rodada lê só ingressos ainda válidos, e o `make load-gate-prepare` seguinte compra só o que falta para voltar a `GATE_TICKETS`. O total é configurável (`GATE_TICKETS=5000` para uma rodada curta).

A rodada (`gate.sh run`) exporta os IDs dos ingressos válidos do banco `checkin` para `.data/gate-tickets.txt` (fora do Git), e o k6 monta o QR code de cada um no formato antigo, que a portaria ainda aceita (`LOTOU1.<id>.<HMAC>`, ADR 15, com a chave de desenvolvimento): o k6 não tem Ed25519 para assinar como o order-service faz hoje (ADR 38), e a conferência das duas assinaturas custa o mesmo para o teste. As leituras saem num ritmo fixo (`RATE`, 150 por segundo), em rodízio pelos 10 portões. A cada 20 ingressos, um é lido de novo: metade logo em seguida, em outro portão (a corrida entre portões que o `SET NX` no Redis decide), e metade umas 500 leituras depois. Os thresholds exigem exatamente um `ACCEPTED` por ingresso e um `ALREADY_USED` por repetição, nenhum outro resultado e p99 abaixo de 200 ms. O `check-gate.sql` confere no banco: nenhum ingresso com duas entradas, `valid_tickets` como `USED` se e só se há entrada em `checkins`, e toda recusa por "já utilizado" com a entrada que a justifica.

Variáveis: `GATE_TICKETS` (30000), `RATE` (150 leituras/s), `GATES` (10), `REPEAT_RATE` (0.05) e, no preparo, `VUS` (10 compradores).

Resultado (27/11/2026, 30 mil ingressos, 150 leituras por segundo, 3 min 30 s):

| Medida | Valor |
| --- | --- |
| Leituras | 31.500 (30.000 ingressos e 1.500 repetidas) |
| Liberadas (`ACCEPTED`) | 30.000, uma por ingresso |
| Barradas como já utilizadas (`ALREADY_USED`) | 1.500, todas as repetidas |
| Outros resultados | 0 |
| Ingressos com duas entradas no banco | 0 |
| `POST /v1/checkins`: p50 / p95 / p99 / máximo | 10,7 ms / 66 ms / 145 ms / 557 ms |
| Entradas por portão | 2.968 a 3.032 (as repetidas na hora disputam o portão) |
| Preparo dos 30 mil ingressos (7.500 pedidos pela saga) | 8 min |

150 leituras por segundo são 30 mil entradas em 3 minutos e meio, quase 20 vezes o ritmo de uma portaria de verdade (30 mil pessoas em uma hora dão 8 por segundo). Nesta máquina o checkin-service satura perto de 265 leituras por segundo: pedindo 500, ele atendeu 265 com p99 de 4,6 s e o k6 descartou o resto. Até a saturação, a regra se manteve: nenhuma entrada dupla em nenhuma rodada.

## Cupom disputado

**Prova:** o limite do cupom é exato sob disputa (ADR 33): exatamente 100 pedidos levam o cupom, os outros 900 são recusados com `coupon-invalid` (`EXHAUSTED`), e no banco `orders` o cupom fica com `uses = 100`, 100 usos registrados e 100 pedidos com ele.

```bash
make load-coupon
```

O `setup` cria um show com mil lugares e um cupom de 10% com 100 usos. Cada um dos mil VUs reserva um ingresso e espera o mesmo instante para criar o pedido com o cupom: a disputa é toda na linha do cupom, no update condicional dentro da transação do pedido, e não na reserva.

Variáveis: `BUYERS` (1000) e `LIMIT` (100).

Resultado (27/11/2026, 1.000 compradores, cupom de 100 usos):

| Medida | Valor |
| --- | --- |
| Pedidos com o cupom | 100 |
| Recusados com `coupon-invalid` (`EXHAUSTED`) | 900 |
| Outras respostas | 0 |
| `uses` no banco / usos registrados / pedidos com o cupom | 100 / 100 / 100 |
| Criação do pedido com os mil ao mesmo tempo: p50 / p99 | 2,0 s / 2,65 s |

O tempo é o de mil `POST /orders` chegando no mesmo instante a um order-service com 200 threads, cada um lendo a reserva no inventory antes da transação. Numa rodada com o ambiente ocupado, algumas dessas leituras passaram dos 5 s do cliente HTTP e o order-service respondeu `503 upstream-unavailable`; o script repete o pedido como a loja faria (até 3 vezes, contado em `lotou_coupon_order_retries`), o que é seguro porque o pedido é único por reserva. Em nenhuma rodada o cupom passou de 100 usos.

## Pico de pedidos com o consumidor lento

**Prova:** o lag do consumer group do analytics sobe enquanto ele está parado e volta a zero quando ele volta, sem perder evento: o relatório do show no analytics bate com os pedidos do order-service.

```bash
make load-consumer-lag
```

O `consumer-lag.sh` para o analytics-service, roda o k6 em segundo plano e sobe o analytics de novo `PAUSE` segundos depois (120), com o pico já terminado; aconteça o que acontecer, o analytics volta. O k6 tem dois cenários: `spike`, com `VUS` compradores (20) comprando pedidos de 1 a 4 ingressos por `DURATION` (60 s), e `watch`, que lê o lag do consumer group da geração ativa (`analytics-service.gen-N`, ADR 30) no Kafka UI a cada 2 s e o publica como `lotou_analytics_lag`. No fim, o k6 lista os pedidos do show no order-service e compara com o relatório do analytics (`/v1/analytics/shows/{id}/statement`): pedidos criados, confirmados, ingressos vendidos e total cobrado. O `check-consumer-lag.sql` mostra os mesmos números lidos do banco `orders`.

Resultado (27/11/2026, 20 compradores por 60 s, analytics parado por 120 s):

| Medida | Valor |
| --- | --- |
| Pedidos no pico | 9.285 (155 por segundo), nenhum recusado |
| Lag máximo do consumer group | 18.039 mensagens |
| Lag quando o analytics voltou | 17.849 |
| Tempo até o lag voltar à linha de base | 292 s |
| Relatório do analytics × order-service × banco `orders` | 9.285 pedidos, 9.285 confirmados, 23.208 ingressos, R$ 2.552.880,00 nos três |

O lag "zerado" é a linha de base medida antes do pico, não zero: o event-service publica em transações Kafka (ADR 29), e o marcador de commit ocupa um offset que o consumidor não confirma; a partição cujo último registro veio numa transação fica com lag 1 mesmo com o consumidor em dia. O lag passou do limite do alerta "Consumer lag" (1.000 por 2 minutos) durante todo o teste, como devia.

O analytics recuperou umas 60 mensagens por segundo, menos que o ritmo do pico (cada pedido gera vários eventos em `order.events` e `inventory.events`). Com 155 pedidos por segundo, ele ficaria para trás mesmo sem parar: o painel continuaria certo, só atrasado. Fica como ponto a investigar a vazão do consumidor do analytics.

## Geração dos ingressos com 1, 2 e 4 workers

**Prova:** a vazão da fila `tickets.render` cresce com o número de workers do notification-service (`RENDER_WORKERS`: processos do pool de PDF, cada um com um consumidor de prefetch 1).

```bash
make load-render
```

O `render.sh` para o notification-service e compra `ORDERS` pedidos de 4 ingressos (3000): com o serviço parado, os `TicketsIssued` esperam no Kafka. Depois sobe o serviço com 1, 2 e 4 workers, um de cada vez (`NOTIFICATION_RENDER_WORKERS` no Compose), e mede a vazão enquanto a fila ainda está cheia, pelo contador de acks da fila na API de management do RabbitMQ, durante `WINDOW` segundos (40). A API atualiza as estatísticas a cada 5 s; a vazão é calculada entre a primeira e a última mudança do contador na janela, que caem nas mesmas marcas, então não depende de quando o k6 consultou. No fim, o serviço volta com o padrão do Compose (2 workers) e esvazia o que sobrou.

Resultado (27/11/2026, 3.000 pedidos de 4 ingressos, janela de 40 s com a fila cheia):

| Workers | PDFs (pedidos) por segundo | Ganho sobre 1 worker |
| --- | --- | --- |
| 1 | 16,1 | 1,0× |
| 2 | 26,8 | 1,7× |
| 4 | 40,6 | 2,5× |

A vazão cresce com os workers, mas abaixo do linear: são 4 CPUs para os quatro processos de PDF, o processo principal do serviço (que consome o Kafka, publica o e-mail com o PDF e o envia), o RabbitMQ e o resto do ambiente. Numa máquina com mais núcleos, ou com workers em containers separados, a curva continua.
