#!/usr/bin/env bash
# Teste de carga da portaria em duas etapas (docs/projeto.md, "Testes, carga e caos").
#
#   gate.sh prepare N   compra ingressos até o show da portaria ter N ingressos válidos na cópia
#                       local do checkin-service e espera os PDFs saírem da fila (make load-gate-prepare)
#   gate.sh run N       lê N ingressos válidos em 10 portões, com 5% de leituras repetidas, e
#                       confere as entradas no banco checkin (make load-gate)
#
# O show preparado serve para várias rodadas: cada rodada usa só ingressos ainda válidos, e o
# preparo seguinte compra o que faltar. COMPOSE é o comando do Compose (padrão: docker compose).
set -euo pipefail

COMPOSE="${COMPOSE:-docker compose}"
TITLE='Teste de carga: portaria'
DIR="$(cd "$(dirname "$0")" && pwd)"
TICKET_FILE="${DIR}/.data/gate-tickets.txt"

checkin_sql() {
  ${COMPOSE} exec -T postgres psql -U lotou -d checkin -Atq -v ON_ERROR_STOP=1 "$@"
}

# O show preparado mais recente que ainda não começou (a cópia local do catálogo, no checkin).
prepared_show() {
  checkin_sql -c "SELECT show_id FROM shows WHERE title = '${TITLE}' AND starts_at > now() + interval '1 hour'
                  AND (doors_open_at IS NULL OR doors_open_at <= now()) ORDER BY updated_at DESC LIMIT 1"
}

valid_tickets() {
  checkin_sql -c "SELECT count(*) FROM valid_tickets WHERE show_id = '$1' AND status = 'VALID'"
}

render_backlog() {
  ${COMPOSE} exec -T rabbitmq rabbitmqctl list_queues -q --no-table-headers name messages 2>/dev/null |
    awk '$1 == "tickets.render" { print $2 }'
}

prepare() {
  local target="$1" show valid
  show="$(prepared_show)"
  valid=0
  if [[ -n "${show}" ]]; then
    valid="$(valid_tickets "${show}")"
    echo "Show da portaria já preparado: ${show}, com ${valid} ingressos válidos"
  fi
  if (( valid < target )); then
    ${COMPOSE} run --rm --no-deps -e TICKETS="${target}" -e VALID="${valid}" -e SHOW_ID="${show}" -e VUS="${VUS:-}" \
      k6 run gate-prepare.js
  fi

  # A cópia local chega pelo Kafka (TicketsIssued). Espera até ter a meta ou parar de crescer.
  for _ in $(seq 1 60); do
    show="$(prepared_show)"
    [[ -n "${show}" ]] && break
    sleep 2
  done
  [[ -n "${show}" ]] || { echo "O show da portaria não chegou ao checkin-service" >&2; exit 1; }
  local last=-1 still=0
  while :; do
    valid="$(valid_tickets "${show}")"
    (( valid >= target )) && break
    if (( valid == last )); then still=$((still + 1)); else still=0; fi
    (( still >= 30 )) && { echo "A cópia local parou em ${valid} de ${target} ingressos" >&2; exit 1; }
    last="${valid}"
    echo "  cópia local da portaria: ${valid} de ${target} ingressos"
    sleep 2
  done
  echo "Show ${show}: ${valid} ingressos válidos na portaria"

  # O notification-service gera um PDF por pedido. Espera a fila esvaziar, para a rodada da
  # portaria não disputar CPU com a geração dos ingressos.
  local backlog
  while backlog="$(render_backlog)"; [[ -n "${backlog}" && "${backlog}" -gt 0 ]]; do
    echo "  PDFs na fila tickets.render: ${backlog}"
    sleep 5
  done
  echo "Fila tickets.render vazia. Pronto para: make load-gate"
}

run() {
  local target="$1" show valid started
  show="$(prepared_show)"
  [[ -n "${show}" ]] || { echo "Nenhum show da portaria preparado. Rode: make load-gate-prepare" >&2; exit 1; }
  valid="$(valid_tickets "${show}")"
  if (( valid < target )); then
    echo "O show ${show} tem ${valid} ingressos válidos, menos que ${target}. Rode: make load-gate-prepare" >&2
    exit 1
  fi
  mkdir -p "$(dirname "${TICKET_FILE}")"
  checkin_sql -c "SELECT ticket_id FROM valid_tickets WHERE show_id = '${show}' AND status = 'VALID'
                  ORDER BY ticket_id LIMIT ${target}" > "${TICKET_FILE}"
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Show ${show}: lendo ${target} ingressos"

  local status=0
  ${COMPOSE} run --rm --no-deps -e SHOW_ID="${show}" -e RATE="${RATE:-}" -e GATES="${GATES:-}" \
    -e REPEAT_RATE="${REPEAT_RATE:-}" k6 run --out experimental-prometheus-rw gate.js || status=$?

  # As recusas são gravadas em lote, fora da requisição: dá tempo ao último lote.
  sleep 3
  ${COMPOSE} exec -T postgres psql -U lotou -d checkin -v ON_ERROR_STOP=1 \
    -v show="${show}" -v since="${started}" -f /dev/stdin < "${DIR}/check-gate.sql"
  return "${status}"
}

case "${1:-}" in
  prepare) prepare "${2:-30000}" ;;
  run) run "${2:-30000}" ;;
  *) echo "Uso: $0 prepare|run N" >&2; exit 2 ;;
esac
