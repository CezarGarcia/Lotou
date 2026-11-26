# 0023. Fase 1 sem broker: integração síncrona e pagamento simulado

- **Status:** aceita; será substituída na fase 3 (Kafka e saga)
- **Data:** 2026-11-26

## Contexto

A arquitetura do Lotou liga os serviços por eventos: o catálogo chega ao inventory pelo tópico `shows.catalog`, e o checkout é uma saga com comandos no Kafka e um payment-mock. Tudo isso entra na fase 3.

A fase 1 vem antes, de propósito: ela precisa de um checkout de ponta a ponta funcionando, com reserva por lock no Postgres, para servir de linha de base das fases seguintes. Sem Kafka e sem payment-mock, três ligações entre serviços precisavam de alguma solução agora:

1. Como o inventory fica sabendo dos shows, setores e lotes?
2. Como o order-service confirma ou libera a reserva?
3. Quem aprova o pagamento?

Antecipar o Kafka resolveria as três, mas misturaria as fases e tiraria da fase 3 a comparação que ela quer mostrar.

## Decisão

Na fase 1 os serviços conversam por **HTTP síncrono**, com soluções simples e explicitamente provisórias:

1. **Catálogo por polling.** O event-service expõe `GET /internal/v1/catalog/shows`, com leitura incremental por `updatedAfter` e cursor. O inventory lê de tempos em tempos e aplica cada show de forma idempotente (a versão do show decide se a cópia local muda).
2. **Reserva por API interna.** O order-service chama `GET`, `POST .../confirm` e `POST .../release` em `/internal/v1/reservations` do inventory. Confirmar e liberar são idempotentes.
3. **Pagamento simulado no order-service.** O checkout depende de uma porta, `PaymentGateway`. A implementação da fase 1 aprova os pedidos, menos uma porcentagem configurável, e responde igual para o mesmo pedido.

As chamadas entre serviços usam o token da conta de serviço de quem chama (client credentials no Keycloak, papel `service`), e as rotas `/internal` não têm rota no gateway.

O checkout fica síncrono: `POST /orders` devolve o pedido já confirmado ou cancelado. Para aguentar falha no meio sem transação distribuída, cada passo grava o que decidiu, é idempotente, e um job retoma os pedidos que ficaram pendentes.

## Consequências

- A fase 1 entrega o checkout completo sem depender de peças das fases seguintes, e os testes de ponta a ponta rodam com dois serviços e um Postgres.
- O polling tem atraso (2 s por padrão) entre publicar um show e o inventory conhecê-lo. Como as vendas abrem em horário marcado, o atraso não aparece para o comprador. Em troca, não há escrita dupla: se o event-service cair, a leitura só é repetida depois.
- O checkout síncrono acopla a disponibilidade: se o inventory não responde, o pedido fica pendente até o job retomar. É exatamente o acoplamento que a saga assíncrona da fase 3 remove, e esta fase deixa o problema visível.
- O contrato do `POST /orders` já está pronto para a troca: a resposta traz o pedido no estado em que ficou, e o cliente lê o `status`. Na fase 3 ele passa a vir `PENDING`.
- O que será substituído na fase 3: o polling vira consumo de `shows.catalog`; as chamadas de confirmar e liberar viram os comandos `ConfirmReservation` e `ReleaseReservation`; o simulador dá lugar ao payment-mock; o job de retomada vira a tabela `saga_state` com outbox.
- O que fica: as regras de reserva, a idempotência dos passos, as tabelas de estado e os testes de concorrência.
