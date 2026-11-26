# Lotou

Plataforma de venda de ingressos para shows, construída como projeto de portfólio. Produto completo (loja, painel do produtor e portaria) com engenharia para alta concorrência na abertura de vendas.

**O documento do projeto é `docs/projeto.md`.** Ele define escopo, regras de negócio, estados, arquitetura, modelo de dados, mensageria, observabilidade, ADRs e roadmap. Antes de implementar qualquer coisa, leia as seções relevantes dele. Se uma tarefa contradiz o documento, pergunte antes de seguir.

## Fase atual

Fase 0 (Fundação). O checklist está em `docs/projeto.md`, seção "Roadmap", subseção "Primeiros passos (fase 0)".

## Stack

| Serviço | Stack |
| --- | --- |
| `apps/web` | Angular (standalone components, signals, novo control flow) |
| `api-gateway` | Java, Spring Cloud Gateway |
| `inventory-service`, `order-service` | Java, Spring Boot |
| `event-service`, `checkin-service`, `payment-mock` | Node, NestJS |
| `analytics-service`, `notification-service`, `producer-assistant` | Python, FastAPI (LangGraph no assistente) |
| Infra | Postgres, MongoDB, Redis (`redis-cache` e `redis-core`), Kafka (KRaft), RabbitMQ, Keycloak, OpenTelemetry + Grafana LGTM |

Monorepo com pastas simples: cada serviço usa a ferramenta nativa da sua linguagem. Na raiz ficam o Makefile, o Docker Compose e o CI com filtros de caminho.

## Comandos

- `make up` / `make down`: sobe e derruba o ambiente com Docker Compose
- `make test`: roda os testes de todos os serviços
- `make seed`: carrega shows, locais e compradores fictícios

(Ajuste esta seção quando os comandos existirem.)

## Convenções obrigatórias

- Dinheiro em centavos, como inteiro (`BIGINT`, `long`). Nunca `float` ou `double`.
- Datas gravadas em UTC (`timestamptz`), exibidas no fuso do show.
- IDs em UUID v7.
- CPF e e-mail nunca aparecem em logs, traces ou chaves do Redis (use hash do CPF).
- Transições de estado validadas por uma tabela única por entidade (veja "Estados" no documento). Transição fora da tabela é recusada.
- Eventos no passado (`OrderConfirmed`), comandos no imperativo (`AuthorizePayment`), com envelope versionado.
- APIs REST com erros em Problem Details (RFC 9457), paginação por cursor e `Idempotency-Key` em POST que cria recurso.
- Commits no padrão Conventional Commits.

## Como trabalhar neste repositório

- Implemente só o que pertence à fase atual. Não antecipe código de fases seguintes.
- Não adicione tecnologias, bibliotecas grandes ou serviços que não estão no documento sem perguntar.
- Toda decisão de arquitetura nova vira um ADR em `docs/adr/NNNN-titulo.md` (contexto, decisão, consequências), escrito na hora da decisão.
- Se uma decisão mudar algo do documento, atualize `docs/projeto.md` no mesmo commit.
- Testes de integração usam Testcontainers com as dependências reais, não mocks de banco ou broker.
- Todo serviço novo já nasce instrumentado com OpenTelemetry.
