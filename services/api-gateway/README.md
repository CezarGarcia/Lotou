# api-gateway

Porta de entrada da API do Lotou. Java 21, Spring Boot 4 e Spring Cloud Gateway (WebFlux).

Faz duas coisas: **roteia** para os serviços e **valida o JWT** emitido pelo Keycloak. O rate limit no Redis entra na fase 2.

## Rotas

| Caminho | Destino | Acesso |
| --- | --- | --- |
| `GET /api/v1/shows/**`, `GET /api/v1/venues/**` | event-service | público |
| demais métodos em `/api/v1/shows/**` e `/api/v1/venues/**` | event-service | papel `producer` |
| `/actuator/health/**` | o próprio gateway | público |
| qualquer outra | — | exige autenticação (fechado por padrão) |

O prefixo `/api` é removido antes de repassar (`/api/v1/shows` vira `/v1/shows`) e o cabeçalho `Authorization` segue intacto, porque cada serviço valida o token de novo ([ADR 21](../../docs/adr/0021-servicos-revalidam-o-jwt.md)).

As rotas ficam em [`application.yml`](src/main/resources/application.yml) e as regras de acesso em [`SecurityConfig`](src/main/java/br/com/lotou/gateway/security/SecurityConfig.java).

## Erros

Os erros que nascem no gateway saem em Problem Details (RFC 9457), no mesmo formato dos serviços:

| Tipo | Status | Quando |
| --- | --- | --- |
| `urn:lotou:problem:unauthorized` | 401 | token ausente, expirado ou inválido |
| `urn:lotou:problem:forbidden` | 403 | usuário sem o papel exigido |
| `urn:lotou:problem:upstream-unavailable` | 503 | o serviço de destino está fora do ar |
| `urn:lotou:problem:upstream-timeout` | 504 | o serviço de destino não respondeu a tempo |

Erros devolvidos pelos serviços passam sem alteração.

## Observabilidade

A imagem Docker roda com o Java agent do OpenTelemetry: traces, métricas e logs saem por OTLP sem código de instrumentação, e o `traceparent` recebido do navegador é propagado ao serviço de destino. O agent é baixado pelo Maven (`target/agent`), na versão fixada no `pom.xml`.

## Comandos

```bash
./mvnw test      # inclui um teste com Keycloak real via Testcontainers (precisa de Docker)
./mvnw package   # gera target/api-gateway.jar e target/agent/opentelemetry-javaagent.jar
./mvnw spring-boot:run
```

## Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `8080` | porta HTTP |
| `EVENT_SERVICE_URL` | `http://localhost:3001` | endereço do event-service |
| `AUTH_ISSUER` | `http://localhost:8180/realms/lotou` | emissor esperado no JWT |
| `AUTH_JWKS_URI` | `<emissor>/protocol/openid-connect/certs` | de onde baixar as chaves públicas |
| `AUTH_AUDIENCE` | `lotou-api` | audiência esperada no JWT |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | endereço do OTel Collector |
