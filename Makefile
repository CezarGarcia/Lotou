# Lotou: comandos do monorepo. `make` ou `make help` lista tudo.

COMPOSE ?= docker compose
INFRA   := postgres mongodb redis-cache redis-core kafka kafka-init kafka-ui rabbitmq mailpit keycloak otel-collector lgtm

.DEFAULT_GOAL := help
.PHONY: help up infra down clean seed smoke logs ps test load-opening load-contention load-show-page load-check \
	test-event-service test-api-gateway test-inventory-service test-order-service test-payment-mock test-checkin-service \
	test-analytics-service test-notification-service test-web replay-analytics requeue-notifications

help: ## Lista os comandos
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Sobe o ambiente inteiro e espera ficar saudável
	$(COMPOSE) up -d --build --wait
	@echo ""
	@echo "  Loja ........ http://localhost:4200"
	@echo "  API ......... http://localhost:8080/api/v1/shows"
	@echo "  Grafana ..... http://localhost:3000   (traces: Explore > Tempo)"
	@echo "  Keycloak .... http://localhost:8180   (admin / admin)"
	@echo "  E-mails ..... http://localhost:8025   (Mailpit)"
	@echo "  RabbitMQ .... http://localhost:15672  (lotou / lotou)"
	@echo ""
	@echo "  Primeira vez? Rode 'make seed' para criar os shows fictícios."

infra: ## Sobe só a infraestrutura (bancos, Redis, Keycloak e observabilidade)
	$(COMPOSE) up -d --wait $(INFRA)

down: ## Derruba o ambiente e mantém os dados
	$(COMPOSE) down --remove-orphans

clean: ## Derruba o ambiente e apaga os dados (volumes)
	$(COMPOSE) down --volumes --remove-orphans

seed: ## Carrega locais e shows fictícios (pode rodar mais de uma vez)
	$(COMPOSE) run --rm seed

smoke: ## Confere o ambiente no ar: faz uma compra de ponta a ponta e confere os traces no Tempo
	$(COMPOSE) run --rm smoke

# Testes de carga (k6, dentro do Compose). ENGINE escolhe o motor de reserva do inventory.
ENGINE ?= redis
VUS ?=
DURATION ?=

load-opening: ## Carga: abertura de vendas (ENGINE=redis|postgres, VUS=2000)
	RESERVATION_ENGINE=$(ENGINE) $(COMPOSE) up -d --wait inventory-service
	-$(COMPOSE) run --rm -e VUS=$(VUS) -e DURATION=$(DURATION) k6 run --out experimental-prometheus-rw reservation-opening.js
	@$(MAKE) --no-print-directory load-check

load-contention: ## Carga: mil compradores pelas mesmas 50 cadeiras (ENGINE=redis|postgres)
	RESERVATION_ENGINE=$(ENGINE) $(COMPOSE) up -d --wait inventory-service
	-$(COMPOSE) run --rm -e VUS=$(VUS) k6 run --out experimental-prometheus-rw seat-contention.js
	@$(MAKE) --no-print-directory load-check

load-show-page: ## Carga: página do show com o cache ligado e desligado
	SHOW_CACHE_ENABLED=true RATE_LIMIT_ENABLED=false $(COMPOSE) up -d --wait event-service
	-$(COMPOSE) run --rm k6 run --out experimental-prometheus-rw show-page.js
	SHOW_CACHE_ENABLED=false RATE_LIMIT_ENABLED=false $(COMPOSE) up -d --wait event-service
	-$(COMPOSE) run --rm k6 run --out experimental-prometheus-rw show-page.js
	$(COMPOSE) up -d --wait event-service

load-check: ## Confere no Postgres as invariantes de venda (tudo deve dar zero)
	@./scripts/wait-projection.sh "$(COMPOSE)"
	$(COMPOSE) exec -T postgres psql -U lotou -d inventory -f /dev/stdin < load-tests/check-invariants.sql

logs: ## Acompanha os logs de todos os serviços
	$(COMPOSE) logs -f --tail=100

ps: ## Mostra o estado dos containers
	$(COMPOSE) ps

test: test-event-service test-api-gateway test-inventory-service test-order-service test-payment-mock test-checkin-service test-analytics-service test-notification-service test-web ## Roda os testes de todos os serviços

test-event-service: ## Testes do event-service (unitários e integração com Testcontainers)
	cd services/event-service && ([ node_modules/.package-lock.json -nt package-lock.json ] || npm ci) && npm test && npm run test:e2e

test-api-gateway: ## Testes do api-gateway (inclui Keycloak real via Testcontainers)
	cd services/api-gateway && ./mvnw -B -q test

test-inventory-service: ## Testes do inventory-service (regras de lote e concorrência num Postgres real)
	cd services/inventory-service && ./mvnw -B -q test

# O checkout de ponta a ponta roda o inventory-service de verdade, a partir da imagem Docker dele.
test-order-service: ## Testes do order-service (checkout de ponta a ponta com o inventory real)
	$(COMPOSE) build inventory-service
	cd services/order-service && ./mvnw -B -q test

test-payment-mock: ## Testes do payment-mock (unitários e integração com Postgres e Kafka via Testcontainers)
	cd services/payment-mock && ([ node_modules/.package-lock.json -nt package-lock.json ] || npm ci) && npm test && npm run test:e2e

test-checkin-service: ## Testes do checkin-service (unitários e integração com Postgres, Redis e Kafka via Testcontainers)
	cd services/checkin-service && ([ node_modules/.package-lock.json -nt package-lock.json ] || npm ci) && npm test && npm run test:e2e

test-analytics-service: ## Testes do analytics-service (lint, tipos, unitários e integração com Kafka, MongoDB e Redis reais)
	cd services/analytics-service && uv sync --locked && uv run ruff check && uv run ruff format --check && uv run mypy && uv run pytest

test-notification-service: ## Testes do notification-service (lint, tipos, unitários e integração com Kafka, RabbitMQ, Redis e Mailpit reais)
	cd services/notification-service && uv sync --locked && uv run ruff check && uv run ruff format --check && uv run mypy && uv run pytest

# Reconstrói os read models do analytics a partir do começo dos tópicos, sem parar a leitura.
replay-analytics: ## Replay dos read models do analytics (roda dentro do container no ar)
	$(COMPOSE) exec analytics-service python -m analytics.replay

# Devolve as mensagens das DLQs do notification-service para uma nova rodada de tentativas.
requeue-notifications: ## Devolve as DLQs de e-mail e de PDF para a fila (roda dentro do container no ar)
	$(COMPOSE) exec notification-service python -m notification.dlq requeue

test-web: ## Testes unitários do Angular
	cd apps/web && ([ node_modules/.package-lock.json -nt package-lock.json ] || npm ci) && npm test -- --watch=false
