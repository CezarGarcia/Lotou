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
| [0004](0004-constraint-unica-de-show-e-assento.md) | Constraint única de show e assento nos ingressos | aceita |
| [0018](0018-um-banco-por-servico.md) | Um banco por serviço | aceita |
| [0019](0019-keycloak-como-provedor-de-identidade.md) | Keycloak como provedor de identidade | aceita |
| [0020](0020-monorepo-com-pastas-simples.md) | Monorepo com pastas simples | aceita |
| [0021](0021-servicos-revalidam-o-jwt.md) | Os serviços revalidam o JWT que o gateway já validou | aceita |
| [0022](0022-idempotency-key-do-event-service-no-mongodb.md) | Idempotency-Key do event-service no MongoDB | aceita |
| [0023](0023-fase-1-sem-broker-integracao-sincrona.md) | Fase 1 sem broker: integração síncrona e pagamento simulado | aceita; substituída na fase 3 |
| [0024](0024-cpf-como-hmac-e-limite-por-cpf-no-banco.md) | CPF gravado como HMAC e limite por CPF conferido no banco | aceita |
| [0025](0025-devolucao-reabre-o-ultimo-lote.md) | Devolução de ingresso reabre o último lote; reserva sai de um lote só | aceita |
