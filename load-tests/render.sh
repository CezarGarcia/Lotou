#!/usr/bin/env bash
# Geração dos ingressos com 1, 2 e 4 workers (make load-render).
#
# Para o notification-service e compra ORDERS pedidos (ticket-render.js, PHASE=buy): os
# TicketsIssued esperam no Kafka. Depois sobe o serviço com cada número de workers
# (RENDER_WORKERS), um de cada vez, e mede a vazão da fila tickets.render enquanto ela ainda está
# cheia (PHASE=drain). No fim, o serviço volta com o número de workers padrão do Compose e esvazia
# o que sobrou na fila. COMPOSE é o comando do Compose (padrão: docker compose).
set -euo pipefail

COMPOSE="${COMPOSE:-docker compose}"
WORKERS_LIST="${WORKERS_LIST:-1 2 4}"

restore() {
  echo "notification-service de volta com os workers padrão"
  ${COMPOSE} up -d --no-deps --wait notification-service
}

${COMPOSE} stop notification-service
trap restore EXIT

${COMPOSE} run --rm --no-deps -e PHASE=buy -e ORDERS="${ORDERS:-}" -e VUS="${VUS:-}" k6 run ticket-render.js

status=0
for workers in ${WORKERS_LIST}; do
  NOTIFICATION_RENDER_WORKERS="${workers}" ${COMPOSE} up -d --no-deps --wait notification-service
  ${COMPOSE} run --rm --no-deps -e PHASE=drain -e WORKERS="${workers}" -e WINDOW="${WINDOW:-}" \
    k6 run --out experimental-prometheus-rw ticket-render.js || status=$?
done
exit "${status}"
