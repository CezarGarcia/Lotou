# api-gateway

Porta de entrada da API do Lotou. Java 21, Spring Boot 4 e Spring Cloud Gateway (WebFlux).

Faz três coisas: **roteia** para os serviços, **valida o JWT** emitido pelo Keycloak e **limita a taxa** das operações de compra, com um token bucket no `redis-core`.

## Rotas

| Caminho | Destino | Acesso |
| --- | --- | --- |
| `GET /api/v1/shows/**`, `GET /api/v1/venues/**` | event-service | público |
| demais métodos em `/api/v1/shows/**` e `/api/v1/venues/**` | event-service | papel `producer` |
| `GET /api/v1/availability/**` (inclui o SSE do mapa) | inventory-service | público |
| `/api/v1/reservations/**`, `/api/v1/queue/**` | inventory-service | papel `buyer` |
| `/api/v1/lots/**` | inventory-service | papel `producer` |
| `/api/v1/orders/**` | order-service | papel `buyer` |
| `/actuator/health/**` | o próprio gateway | público |
| qualquer outra | — | exige autenticação (fechado por padrão) |

As APIs internas dos serviços (`/internal/**`) não têm rota no gateway. O prefixo `/api` é removido antes de repassar (`/api/v1/shows` vira `/v1/shows`) e o cabeçalho `Authorization` segue intacto, porque cada serviço valida o token de novo ([ADR 21](../../docs/adr/0021-servicos-revalidam-o-jwt.md)).

As rotas ficam em [`application.yml`](src/main/resources/application.yml) e as regras de acesso em [`SecurityConfig`](src/main/java/br/com/lotou/gateway/security/SecurityConfig.java).

## Rate limit da compra

As três operações que disputam estoque têm um balde por usuário (o `sub` do token; sem token, um hash do IP), com o `RedisRateLimiter` do Spring Cloud Gateway (token bucket num script Lua do `redis-core`):

| Operação | Rota | Por segundo | Rajada |
| --- | --- | --- | --- |
| reservar | `POST /api/v1/reservations` | 5 | 10 |
| entrar na fila | `POST /api/v1/queue/{showId}` | 2 | 5 |
| criar pedido | `POST /api/v1/orders` | 2 | 5 |

Acima do limite, a resposta é 429 em Problem Details (`urn:lotou:problem:rate-limited`), com `Retry-After`. Se o Redis estiver fora do ar, a requisição passa: o limite protege o serviço, mas não pode derrubar a venda. O event-service tem um limite próprio, por janela deslizante, nas leituras do catálogo, para comparar os dois algoritmos.

O IP só vem do `X-Forwarded-For` quando a conexão chega de uma rede privada (o nginx da loja); de fora, vale o endereço da conexão, que não dá para forjar.

Os fluxos SSE da fila e do mapa de assentos têm uma rota própria, sem o timeout de 10 s das outras.

## Erros

Os erros que nascem no gateway saem em Problem Details (RFC 9457), no mesmo formato dos serviços:

| Tipo | Status | Quando |
| --- | --- | --- |
| `urn:lotou:problem:unauthorized` | 401 | token ausente, expirado ou inválido |
| `urn:lotou:problem:forbidden` | 403 | usuário sem o papel exigido |
| `urn:lotou:problem:rate-limited` | 429 | operação de compra acima do limite; `Retry-After` diz quando tentar |
| `urn:lotou:problem:upstream-unavailable` | 503 | o serviço de destino está fora do ar |
| `urn:lotou:problem:upstream-timeout` | 504 | o serviço de destino não respondeu a tempo |

Erros devolvidos pelos serviços passam sem alteração.

## Observabilidade

A imagem Docker roda com o Java agent do OpenTelemetry: traces, métricas e logs saem por OTLP sem código de instrumentação, e o `traceparent` recebido do navegador é propagado ao serviço de destino. O agent é baixado pelo Maven (`target/agent`), na versão fixada no `pom.xml`.

## Comandos

```bash
./mvnw test      # inclui Keycloak e Redis reais via Testcontainers (precisa de Docker)
./mvnw package   # gera target/api-gateway.jar e target/agent/opentelemetry-javaagent.jar
./mvnw spring-boot:run
```

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `8080` | porta HTTP |
| `EVENT_SERVICE_URL` | `http://localhost:3001` | endereço do event-service |
| `INVENTORY_SERVICE_URL` | `http://localhost:8082` | endereço do inventory-service |
| `ORDER_SERVICE_URL` | `http://localhost:8083` | endereço do order-service |
| `REDIS_URL` | `redis://localhost:6380` | `redis-core`, onde ficam os baldes do rate limit |
| `RATE_LIMIT_RESERVE_PER_SECOND`, `RATE_LIMIT_RESERVE_BURST` | `5`, `10` | limite de reservas por usuário |
| `RATE_LIMIT_QUEUE_PER_SECOND`, `RATE_LIMIT_QUEUE_BURST` | `2`, `5` | limite de entradas na fila por usuário |
| `RATE_LIMIT_ORDER_PER_SECOND`, `RATE_LIMIT_ORDER_BURST` | `2`, `5` | limite de pedidos por usuário |
| `AUTH_ISSUER` | `http://localhost:8180/realms/lotou` | emissor esperado no JWT |
| `AUTH_JWKS_URI` | `<emissor>/protocol/openid-connect/certs` | de onde baixar as chaves públicas |
| `AUTH_AUDIENCE` | `lotou-api` | audiência esperada no JWT |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | endereço do OTel Collector |
