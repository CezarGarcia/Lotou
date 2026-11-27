# Decisões de arquitetura (ADRs)

Cada decisão de arquitetura do Lotou vira um arquivo nesta pasta, escrito no momento da decisão. A lista completa das decisões previstas está em [`docs/projeto.md`](../projeto.md#decisões-de-arquitetura-adrs); os ADRs são escritos conforme cada decisão entra no código.

## Formato

Arquivo `NNNN-titulo-em-kebab-case.md`, com o número da tabela do documento do projeto:

```markdown
# NNNN. Título da decisão

- **Status:** aceita | substituída por NNNN
- **Data:** AAAA-MM-DD

## Contexto
O problema, as restrições e as alternativas consideradas.

## Decisão
O que foi decidido.

## Consequências
O que fica mais fácil, o que fica mais difícil e o que precisa ser revisto depois.
```

## Índice

| # | Decisão | Status |
| --- | --- | --- |
| [0001](0001-kafka-para-eventos-de-dominio.md) | Kafka para eventos de domínio e comandos da saga | aceita |
| [0003](0003-reserva-com-lua-no-redis.md) | Reserva com script Lua no Redis, comparada ao lock no Postgres | aceita |
| [0004](0004-constraint-unica-de-show-e-assento.md) | Constraint única de show e assento nos ingressos | aceita |
| [0005](0005-bitmap-para-o-status-dos-assentos.md) | Bitmap no Redis para o status dos assentos | aceita |
| [0006](0006-reserva-sincrona-pagamento-assincrono.md) | Reserva síncrona, pagamento assíncrono | aceita |
| [0007](0007-saga-orquestrada-pelo-order-service.md) | Saga de compra orquestrada pelo order-service | aceita |
| [0008](0008-outbox-transacional.md) | Outbox transacional, publicado por polling | aceita |
| [0010](0010-duas-instancias-de-redis.md) | Duas instâncias de Redis | aceita |
| [0011](0011-pubsub-streams-e-kafka.md) | Pub/sub para o mapa, Streams para as reservas, Kafka para fatos de domínio | aceita |
| [0013](0013-fila-virtual-so-em-shows-de-alta-demanda.md) | Fila virtual só em shows de alta demanda | aceita |
| [0014](0014-portaria-com-copia-local-dos-ingressos.md) | Portaria com cópia local dos ingressos | aceita |
| [0015](0015-qr-code-assinado-com-hmac.md) | QR code do ingresso assinado com HMAC | aceita |
| [0017](0017-sse-na-loja-websocket-no-painel.md) | SSE na loja, WebSocket no painel | aceita |
| [0018](0018-um-banco-por-servico.md) | Um banco por serviço | aceita |
| [0019](0019-keycloak-como-provedor-de-identidade.md) | Keycloak como provedor de identidade | aceita |
| [0020](0020-monorepo-com-pastas-simples.md) | Monorepo com pastas simples | aceita |
| [0021](0021-servicos-revalidam-o-jwt.md) | Os serviços revalidam o JWT que o gateway já validou | aceita |
| [0022](0022-idempotency-key-do-event-service-no-mongodb.md) | Idempotency-Key do event-service no MongoDB | aceita |
| [0023](0023-fase-1-sem-broker-integracao-sincrona.md) | Fase 1 sem broker: integração síncrona e pagamento simulado | substituída pelos ADRs 1, 7 e 8 na fase 3 |
| [0024](0024-cpf-como-hmac-e-limite-por-cpf-no-banco.md) | CPF gravado como HMAC e limite por CPF conferido no banco | aceita |
| [0025](0025-devolucao-reabre-o-ultimo-lote.md) | Devolução de ingresso reabre o último lote; reserva sai de um lote só | aceita |
| [0026](0026-redis-como-fonte-da-verdade-durante-a-venda.md) | Redis como fonte da verdade durante a venda, com o Postgres alimentado por stream | aceita |
| [0027](0027-oidc-e-sse-na-loja.md) | Login com angular-auth-oidc-client e SSE lido com fetch na loja | aceita |
| [0028](0028-contratos-em-json-schema.md) | Contratos dos eventos em JSON Schema, com exemplos | aceita |
| [0029](0029-outbox-do-event-service-no-mongodb.md) | Outbox do event-service no MongoDB | aceita |
| [0030](0030-replay-dos-read-models.md) | Replay dos read models em gerações, com troca atômica do ponteiro | aceita |
| [0031](0031-hub-de-tempo-real-so-para-o-painel.md) | O analytics é o hub de tempo real do painel; o SSE da loja fica no inventory | aceita |
| [0032](0032-painel-ao-vivo-com-varias-instancias.md) | Painel ao vivo com várias instâncias: interesse em ZSET, um cálculo por show por segundo e feed sem repetição | aceita |
| [0033](0033-uso-do-cupom-contado-no-postgres.md) | Uso do cupom contado no Postgres, na transação do pedido | aceita |
| [0034](0034-reembolso-em-massa-com-fila-e-vazao.md) | Reembolso em massa com fila no Postgres e vazão controlada | aceita |
