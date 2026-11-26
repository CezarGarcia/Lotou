# syntax=docker/dockerfile:1

# ---- build: compila, baixa o Java agent e separa o jar em camadas ----
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app

COPY pom.xml ./
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -q -DskipTests package \
    && java -Djarmode=tools -jar target/order-service.jar extract --layers --destination target/extracted

# ---- runtime: só o JRE, a aplicação e o agent ----
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
RUN addgroup -S lotou && adduser -S lotou -G lotou

COPY --from=build /app/target/agent/opentelemetry-javaagent.jar ./
# Uma camada por tipo de conteúdo, da que menos muda para a que mais muda.
COPY --from=build /app/target/extracted/dependencies/ ./
COPY --from=build /app/target/extracted/spring-boot-loader/ ./
COPY --from=build /app/target/extracted/snapshot-dependencies/ ./
COPY --from=build /app/target/extracted/application/ ./

USER lotou
EXPOSE 8083

# O agent instrumenta a aplicação sem código (HTTP, JDBC, Hibernate) e exporta traces, métricas
# e logs por OTLP. Os logs do console saem em JSON, com trace_id e span_id.
ENV JAVA_TOOL_OPTIONS="-javaagent:/app/opentelemetry-javaagent.jar -XX:MaxRAMPercentage=75" \
    OTEL_SERVICE_NAME=order-service \
    LOGGING_STRUCTURED_FORMAT_CONSOLE=logstash

HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 \
  CMD wget -qO- http://127.0.0.1:8083/actuator/health/readiness > /dev/null || exit 1

ENTRYPOINT ["java", "-jar", "order-service.jar"]
