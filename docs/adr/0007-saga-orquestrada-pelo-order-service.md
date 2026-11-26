# 0007. Saga de compra orquestrada pelo order-service

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Concluir um pedido envolve três serviços: o payment-mock autoriza o pagamento, o inventory confirma ou devolve a reserva, e o order-service emite os ingressos. Não há transação distribuída: cada serviço tem o seu banco (ADR 18). Quando um passo falha, os anteriores precisam ser desfeitos (compensação): pagamento recusado devolve os ingressos à venda; reserva expirada com o pagamento aprovado estorna o pagamento.

Há dois jeitos de coordenar: **coreografia**, em que cada serviço reage aos eventos dos outros e ninguém tem a visão do todo, e **orquestração**, em que um serviço conduz os passos e guarda onde cada pedido está.

## Decisão

Orquestração, pelo order-service:

- O estado de cada saga fica em `saga_state`: o passo atual, a tabela de transições entre passos (`SagaStep`), o motivo da compensação e o prazo da resposta esperada.
- Cada passo envia um comando pelo outbox (ADR 8) e espera a resposta no Kafka: `AuthorizePayment` → `PaymentAuthorized`/`PaymentDeclined`; `ConfirmReservation` ou `ReleaseReservation` → `ReservationConfirmed`/`ReservationReleased`; `RefundPayment` → `PaymentRefunded`.
- **O inventory não responde a comandos: publica fatos.** Toda mudança de status da reserva vira um fato em `inventory.events`, venha de um comando, da expiração ou de qualquer motor. A saga reage a esses fatos em qualquer passo: uma reserva que expira enquanto o pagamento é autorizado marca a saga, e o pagamento aprovado depois é estornado.
- **Prazos:** se a resposta de um passo não chega no prazo (15 s, dobrando a cada tentativa até 8 vezes), um job repete o comando (o payment-mock responde igual a um comando repetido) ou, quando a resposta esperada é um fato da reserva, consulta a reserva no inventory e age pelo estado dela. Isso cobre o fato que foi publicado antes de o pedido existir.
- **Idempotência:** cada resposta processada é gravada em `processed_events` na mesma transação do efeito; uma resposta repetida, ou fora do passo em que faria sentido, não muda nada.
- A última defesa contra venda dupla (ADR 4) também vira compensação: se já existe ingresso ativo para a cadeira, o pedido não é confirmado e o pagamento é estornado.

## Consequências

- O estado de cada pedido está num lugar só, fácil de consultar e de explicar: "a saga do pedido X está esperando a confirmação da reserva desde 18:03".
- O order-service conhece os passos dos outros serviços: um passo novo muda o orquestrador. É aceitável com três participantes; com dezenas, a coreografia escalaria melhor.
- A saga de cancelamento e reembolso (fase 6) segue o mesmo modelo, com outra tabela de passos.
- Um pedido pode ficar PENDING por mais tempo se um participante estiver fora. O job de prazos registra em log de erro as sagas que passam de 5 tentativas, para alerta.
