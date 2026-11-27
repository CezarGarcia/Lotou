#!/usr/bin/env bash
# Cria os tópicos do Lotou (veja contracts/README.md). Idempotente: tópico que
# já existe fica como está.
set -euo pipefail

BOOTSTRAP="${BOOTSTRAP_SERVER:-kafka:9092}"
PARTITIONS="${TOPIC_PARTITIONS:-3}"
KAFKA_TOPICS=/opt/kafka/bin/kafka-topics.sh
WEEK=604800000

create() {
  local topic="$1"; shift
  "${KAFKA_TOPICS}" --bootstrap-server "${BOOTSTRAP}" --create --if-not-exists \
    --topic "${topic}" --partitions "${PARTITIONS}" --replication-factor 1 "$@"
  echo "tópico ${topic}"
}

# Catálogo: compactado, fica a última versão de cada show.
create shows.catalog --config cleanup.policy=compact --config min.compaction.lag.ms=60000

# Fatos lidos no replay dos read models: sem prazo.
create order.events --config retention.ms=-1
create inventory.events --config retention.ms=-1
create checkin.events --config retention.ms=-1

# Comandos e respostas da saga: 7 dias.
create payment.commands --config retention.ms="${WEEK}"
create payment.events --config retention.ms="${WEEK}"
create inventory.commands --config retention.ms="${WEEK}"

# Mensagens que falharam depois das tentativas, para inspeção.
for topic in shows.catalog order.events inventory.events checkin.events payment.commands payment.events inventory.commands; do
  create "${topic}.dlt" --config retention.ms="${WEEK}"
done
