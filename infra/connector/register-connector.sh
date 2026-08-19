#!/bin/sh
# Waits for Kafka Connect's REST API, then registers the Debezium Postgres
# connector so `docker compose up` requires zero manual setup steps.
set -eu

CONNECT_URL="http://kafka-connect:8083"

echo "Waiting for Kafka Connect at ${CONNECT_URL}..."
until curl -sf "${CONNECT_URL}/connectors" >/dev/null; do
  sleep 2
done

echo "Kafka Connect is up. Registering connector..."

status=$(curl -s -o /tmp/register-response.json -w '%{http_code}' \
  -X POST "${CONNECT_URL}/connectors" \
  -H 'Content-Type: application/json' \
  -d @/connector/postgres-connector.json)

if [ "$status" = "201" ] || [ "$status" = "409" ]; then
  echo "Connector registered (or already exists). HTTP $status"
  cat /tmp/register-response.json
  exit 0
fi

echo "Failed to register connector. HTTP $status"
cat /tmp/register-response.json
exit 1
