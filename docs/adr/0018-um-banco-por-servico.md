# 0018. Um banco por serviço

- **Status:** aceita
- **Data:** 2026-11-26

## Contexto

Com a fase 1, três serviços passam a gravar dados: o event-service (catálogo, no MongoDB), o inventory-service (lotes, cadeiras e reservas) e o order-service (pedidos e ingressos). Os dois últimos usam Postgres.

A alternativa era um banco compartilhado: um único esquema no Postgres, em que o order-service leria a reserva com um `JOIN` e o inventory veria os pedidos. É mais simples de começar e dá transações entre "reserva" e "pedido" de graça.

O custo aparece depois: qualquer mudança de tabela vira uma mudança coordenada entre serviços, e a fronteira entre eles deixa de existir na prática. O projeto existe para mostrar o contrário, com consistência entre serviços feita por contratos, idempotência e compensação.

## Decisão

Cada serviço tem **o seu banco e o seu usuário**, e nenhum serviço lê o banco de outro.

- No Compose, uma única instância do Postgres hospeda os bancos `inventory`, `orders` e `keycloak`, cada um com um usuário que só enxerga o seu. Separar em instâncias é mudança de configuração.
- Cada serviço é dono do seu esquema e o evolui com as próprias migrações (Flyway).
- O que um serviço precisa de outro vem por contrato: API (hoje) ou evento (a partir da fase 3). O order-service, por exemplo, não lê a tabela `reservations`; ele pede a reserva ao inventory e copia para o pedido o que precisa guardar (itens e preços).

## Consequências

- Os serviços só se acoplam pelos contratos de API e de eventos. O esquema de um pode mudar sem tocar no outro.
- Não existe transação entre serviços. A consistência entre reserva e pedido vem de passos idempotentes, compensação (liberar a reserva quando o pagamento é recusado) e retomada de pedidos pendentes. Na fase 3 isso ganha outbox e saga.
- Há dados copiados: o inventory guarda uma cópia do catálogo, e o pedido guarda nome de setor, lote e preço. É de propósito: o pedido é um registro do que foi vendido e não pode mudar se o show for editado.
- Consultas que cruzam serviços (o painel do produtor, "meus ingressos" com dados do show) não são `JOIN`: vão virar read models montados a partir de eventos, na fase 3.
