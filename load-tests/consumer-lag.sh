#!/usr/bin/env bash
# Pico de pedidos com o analytics-service parado (make load-consumer-lag).
#
# Para o analytics, roda o k6 (consumer-lag.js) em segundo plano, sobe o analytics de novo PAUSE
# segundos depois (com o pico já terminado) e espera o k6 conferir que o lag voltou a zero e que o
# relatório bate com os pedidos. No fim, mostra os números do banco orders. Aconteça o que
# acontecer, o analytics volta a subir. COMPOSE é o comando do Compose (padrão: docker compose).
set -euo pipefail

COMPOSE="${COMPOSE:-docker compose}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PAUSE="${PAUSE:-120}"

# Só o analytics, sem mexer nas dependências (--no-deps): o resto do ambiente fica como está.
restart_analytics() {
  ${COMPOSE} up -d --no-deps --wait analytics-service
}

${COMPOSE} stop analytics-service
trap restart_analytics EXIT

${COMPOSE} run --rm --no-deps -e VUS="${VUS:-}" -e DURATION="${DURATION:-}" \
  k6 run --out experimental-prometheus-rw consumer-lag.js &
k6_pid=$!

sleep "${PAUSE}"
echo "Subindo o analytics-service de novo, ${PAUSE} s depois da parada"
restart_analytics

status=0
wait "${k6_pid}" || status=$?
${COMPOSE} exec -T postgres psql -U lotou -d orders -v ON_ERROR_STOP=1 -f /dev/stdin < "${DIR}/check-consumer-lag.sql"
exit "${status}"
