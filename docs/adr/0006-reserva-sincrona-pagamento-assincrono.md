# 0006. Reserva síncrona, pagamento assíncrono

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

A compra tem duas partes de natureza diferente. A reserva decide se o comprador garantiu o ingresso, e ele precisa saber disso na hora, na tela. O pagamento depende de um terceiro (o gateway de pagamento) que pode demorar segundos, cair ou responder duas vezes.

Fazer tudo síncrono (a fase 1) prende a requisição do comprador enquanto o pagamento e a confirmação acontecem, e acopla a disponibilidade: se o inventory ou o pagamento não respondem, a compra falha ou fica num estado intermediário que um job precisa retomar (ADR 23). Fazer tudo assíncrono deixaria o comprador sem saber se conseguiu o ingresso.

## Decisão

- **A reserva é síncrona:** `POST /reservations` responde na hora com a reserva segurada por 10 minutos, ou com o motivo da recusa (esgotado, cadeira ocupada, limite do CPF).
- **O pedido é aceito na hora e concluído de forma assíncrona:** `POST /orders` lê a reserva no inventory (síncrono, para recusar na hora uma reserva expirada ou de outra pessoa), cria o pedido PENDING e começa a saga de compra (ADR 7). A resposta é 201 com o pedido PENDING.
- **O cliente acompanha o pedido** pelo `GET /orders/{id}` até CONFIRMED ou CANCELLED. A loja consulta a cada 2 segundos; em geral a saga termina em menos de um segundo.

## Consequências

- O `POST /orders` não depende do pagamento nem da confirmação no inventory: se o payment-mock estiver fora, o pedido é aceito e conclui quando ele voltar.
- O comprador vê "processando" por um instante depois de pagar. A tela de pedido mostra o estado e se atualiza sozinha.
- A reserva continua dependendo do inventory estar no ar: é o preço de responder na hora.
