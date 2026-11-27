#!/bin/sh
# Roda uma única vez, quando o volume do Postgres é criado.
# Cada serviço tem seu próprio banco e seu próprio usuário (ADR 18).
set -eu

create_database() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v name="$1" -v password="$2" <<'SQL'
CREATE ROLE :"name" LOGIN PASSWORD :'password';
CREATE DATABASE :"name" OWNER :"name";
SQL
}

create_database keycloak "$KEYCLOAK_DB_PASSWORD"
create_database inventory "$INVENTORY_DB_PASSWORD"
create_database orders "$ORDERS_DB_PASSWORD"
create_database payments "$PAYMENTS_DB_PASSWORD"
create_database checkin "$CHECKIN_DB_PASSWORD"

# Observabilidade: só leitura. O Collector lê as estatísticas (pg_monitor) e o
# Grafana consulta as invariantes de venda e portaria nos painéis e alertas
# (pg_read_all_data). Não escreve em nada.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v password="$OBSERVER_DB_PASSWORD" <<'SQL'
CREATE ROLE observer LOGIN PASSWORD :'password';
GRANT pg_monitor, pg_read_all_data TO observer;
SQL
