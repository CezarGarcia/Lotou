#!/usr/bin/env bash
# Confere o ambiente no ar (depois de `make up` e `make seed`):
#   1. a loja responde;
#   2. a API devolve os shows do seed pelo mesmo caminho que o navegador usa;
#   3. a requisição gera um trace que atravessa o api-gateway e o
#      event-service até o MongoDB, visível no Tempo.
set -euo pipefail

WEB_URL="${WEB_URL:-http://localhost:4200}"
GRAFANA_URL="${GRAFANA_URL:-http://localhost:3000}"

fail() { echo "FALHOU: $*" >&2; exit 1; }

echo "1. Loja em ${WEB_URL}"
curl -fsS "${WEB_URL}/" | grep -q "<app-root>" || fail "a loja não respondeu"

echo "2. Busca de shows pela API"
trace_id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
span_id="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
shows="$(curl -fsS "${WEB_URL}/api/v1/shows?limit=50" \
  -H "traceparent: 00-${trace_id}-${span_id}-01" | jq '.items | length')"
[ "${shows}" -ge 3 ] || fail "esperava ao menos 3 shows, vieram ${shows}. Rodou 'make seed'?"
echo "   ${shows} shows"

echo "3. Trace ${trace_id} no Tempo"
for attempt in $(seq 1 30); do
  trace="$(curl -fsS "${GRAFANA_URL}/api/datasources/proxy/uid/tempo/api/traces/${trace_id}" 2>/dev/null || true)"
  services="$(jq -r '[.batches[]?.resource.attributes[]? | select(.key == "service.name") | .value.stringValue] | unique | join(" ")' <<<"${trace:-{\}}" 2>/dev/null || true)"
  mongo="$(jq '[.batches[]?.scopeSpans[]?.spans[]?.attributes[]? | select(.key == "db.system.name" or .key == "db.system") | select(.value.stringValue == "mongodb")] | length' <<<"${trace:-{\}}" 2>/dev/null || echo 0)"
  if [[ "${services}" == *api-gateway* && "${services}" == *event-service* && "${mongo}" -ge 1 ]]; then
    echo "   serviços no trace: ${services}"
    echo "   spans do MongoDB: ${mongo}"
    echo "OK: ${GRAFANA_URL}/explore (Tempo), trace ${trace_id}"
    exit 0
  fi
  sleep 2
done
fail "o trace não chegou completo ao Tempo (serviços: ${services:-nenhum}; spans do MongoDB: ${mongo:-0})"
