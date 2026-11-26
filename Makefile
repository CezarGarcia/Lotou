# Lotou: comandos do monorepo. `make` ou `make help` lista tudo.

COMPOSE ?= docker compose
INFRA   := postgres mongodb redis-cache redis-core keycloak otel-collector lgtm

.DEFAULT_GOAL := help
.PHONY: help up infra down clean seed smoke logs ps test \
	test-event-service test-api-gateway test-inventory-service test-order-service test-web

help: ## Lista os comandos
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Sobe o ambiente inteiro e espera ficar saudável
	$(COMPOSE) up -d --build --wait
	@echo ""
	@echo "  Loja ........ http://localhost:4200"
	@echo "  API ......... http://localhost:8080/api/v1/shows"
	@echo "  Grafana ..... http://localhost:3000   (traces: Explore > Tempo)"
	@echo "  Keycloak .... http://localhost:8180   (admin / admin)"
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

logs: ## Acompanha os logs de todos os serviços
	$(COMPOSE) logs -f --tail=100

ps: ## Mostra o estado dos containers
	$(COMPOSE) ps

test: test-event-service test-api-gateway test-inventory-service test-order-service test-web ## Roda os testes de todos os serviços

test-event-service: ## Testes do event-service (unitários e integração com Testcontainers)
	cd services/event-service && ([ -d node_modules ] || npm ci) && npm test && npm run test:e2e

test-api-gateway: ## Testes do api-gateway (inclui Keycloak real via Testcontainers)
	cd services/api-gateway && ./mvnw -B -q test

test-inventory-service: ## Testes do inventory-service (regras de lote e concorrência num Postgres real)
	cd services/inventory-service && ./mvnw -B -q test

# O checkout de ponta a ponta roda o inventory-service de verdade, a partir da imagem Docker dele.
test-order-service: ## Testes do order-service (checkout de ponta a ponta com o inventory real)
	$(COMPOSE) build inventory-service
	cd services/order-service && ./mvnw -B -q test

test-web: ## Testes unitários do Angular
	cd apps/web && ([ -d node_modules ] || npm ci) && npm test -- --watch=false
