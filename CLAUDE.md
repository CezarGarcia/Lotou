# Lotou

Plataforma de venda de ingressos para shows, construída como projeto de portfólio. Produto completo (loja, painel do produtor e portaria) com engenharia para alta concorrência na abertura de vendas.

**O documento do projeto é `docs/projeto.md`.** Ele define escopo, regras de negócio, estados, arquitetura, modelo de dados, mensageria, observabilidade, ADRs e roadmap. Antes de implementar qualquer coisa, leia as seções relevantes dele. Se uma tarefa contradiz o documento, pergunte antes de seguir.

## Fase atual

Fases 0 (Fundação), 1 (Pedidos e estoque), 2 (Redis e abertura de vendas), 3 (Kafka e saga), 4 (RabbitMQ e tempo real) e 6 (Produto completo) concluídas. A próxima é a fase 7 (Vitrine, sem o vídeo), depois a 8 (revisão de UI e UX do sistema inteiro e o vídeo de apresentação); a fase 5 (Agente de IA) ficou para o fim, como complemento. O roadmap e o que cada fase entregou estão em `docs/projeto.md`, seção "Roadmap".

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

Na raiz (`make help` lista todos):

- `make up` / `make down`: sobe e derruba o ambiente com Docker Compose (`make clean` apaga também os volumes)
- `make infra`: sobe só a infraestrutura, para rodar um serviço fora do Compose
- `make seed`: carrega shows e locais fictícios pela API (pode rodar mais de uma vez)
- `make test`: roda os testes de todos os serviços
- `make smoke`: confere o ambiente no ar: compra de ponta a ponta pela saga, cancelamento com reembolso, portaria barrando a segunda entrada e os traces no Tempo (precisa do `make seed` do dia, que cria um show de hoje)
- `make replay-analytics`: reconstrói os read models do analytics a partir do começo dos tópicos, sem parar o serviço
- `make requeue-notifications`: devolve à fila as mensagens que foram para as DLQs do notification-service
- `make load-opening`, `make load-contention` (`ENGINE=redis|postgres`) e `make load-show-page`: testes de carga com k6 dentro do Compose; `make load-check` confere as invariantes no Postgres. Rode `make clean up seed` antes de trocar de motor de reserva

Depois de mudar o realm do Keycloak ou os bancos do Postgres, rode `make clean` antes do `make up`: os dois só são criados com o volume vazio.

Por serviço:

- `services/event-service`: `npm test` (unitários), `npm run test:e2e` (integração com Testcontainers), `npm run lint`, `npm run format:check`
- `services/api-gateway`, `services/inventory-service`: `./mvnw test`
- `services/order-service`: `make test-order-service` na raiz (constrói a imagem do inventory, que os testes de ponta a ponta usam) ou `./mvnw test` se a imagem já existe
- `services/payment-mock`, `services/checkin-service`: `npm test`, `npm run test:e2e`, `npm run lint`, `npm run format:check`
- `services/analytics-service`, `services/notification-service`: `uv run pytest`, `uv run ruff check`, `uv run mypy` (ou `make test-analytics-service` e `make test-notification-service` na raiz)
- `apps/web`: `npm test -- --watch=false`, `npm run build`, `npm run format:check`
- `contracts/`: `python contracts/check.py` confere os JSON Schemas das mensagens e os exemplos

## Convenções obrigatórias

- Dinheiro em centavos, como inteiro (`BIGINT`, `long`). Nunca `float` ou `double`.
- Datas gravadas em UTC (`timestamptz`), exibidas no fuso do show.
- IDs em UUID v7.
- CPF e e-mail nunca aparecem em logs, traces ou chaves do Redis (use hash do CPF).
- Transições de estado validadas por uma tabela única por entidade (veja "Estados" no documento). Transição fora da tabela é recusada.
- Eventos no passado (`OrderConfirmed`), comandos no imperativo (`AuthorizePayment`), com envelope versionado. Toda mensagem nova ou alterada tem JSON Schema e exemplo em `contracts/`, e é publicada por outbox.
- APIs REST com erros em Problem Details (RFC 9457), paginação por cursor e `Idempotency-Key` em POST que cria recurso.
- Commits no padrão Conventional Commits.

## Como trabalhar neste repositório

- Implemente só o que pertence à fase atual. Não antecipe código de fases seguintes.
- Não adicione tecnologias, bibliotecas grandes ou serviços que não estão no documento sem perguntar.
- Toda decisão de arquitetura nova vira um ADR em `docs/adr/NNNN-titulo.md` (contexto, decisão, consequências), escrito na hora da decisão.
- Se uma decisão mudar algo do documento, atualize `docs/projeto.md` no mesmo commit.
- Testes de integração usam Testcontainers com as dependências reais, não mocks de banco ou broker.
- Todo serviço novo já nasce instrumentado com OpenTelemetry.
