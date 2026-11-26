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
