#!/usr/bin/env bash
# Espera o stream de reservas do inventory chegar todo ao Postgres (motor Redis): nada pendente no
# consumer group e nenhuma entrada ainda não lida. Sem o stream (motor Postgres), não espera.
#
# Uso: scripts/wait-projection.sh [comando do compose]
set -euo pipefail

COMPOSE="${1:-docker compose}"

for _ in $(seq 1 120); do
  state="$(${COMPOSE} exec -T redis-core redis-cli XINFO GROUPS stream:reservations 2>/dev/null | tr '\n' ' ' || true)"
  case "${state}" in
    "" | *"pending 0 "*"lag 0"*) exit 0 ;;
  esac
  sleep 1
done
echo "O stream de reservas não chegou ao Postgres em 2 minutos" >&2
exit 1
