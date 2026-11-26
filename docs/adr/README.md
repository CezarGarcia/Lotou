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
| [0019](0019-keycloak-como-provedor-de-identidade.md) | Keycloak como provedor de identidade | aceita |
| [0020](0020-monorepo-com-pastas-simples.md) | Monorepo com pastas simples | aceita |
| [0021](0021-servicos-revalidam-o-jwt.md) | Os serviços revalidam o JWT que o gateway já validou | aceita |
| [0022](0022-idempotency-key-do-event-service-no-mongodb.md) | Idempotency-Key do event-service no MongoDB | aceita |
