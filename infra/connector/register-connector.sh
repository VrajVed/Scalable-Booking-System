#!/bin/sh
# Waits for Kafka Connect's REST API, then registers the Debezium Postgres
# connector so `docker compose up` requires zero manual setup steps.
#
# The connector config template uses __DB_USER__ / __DB_PASSWORD__ /
# __DB_NAME__ placeholders instead of literal credentials, so this
# container's Postgres creds come from the SAME source the postgres
# service uses (POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB resolved
# from infra/.env and passed through docker-compose.yml's connect-init
# environment). Previously the JSON hardcoded "booking_system"/
# "booking_system" directly, which happened to match the dev values but
# would silently drift the moment .env's password changed. Mirrors the
# k8s path (k8s/20-kafka-connect.yaml), which substitutes the same
# placeholders from the postgres-credentials Secret.
set -eu

CONNECT_URL="http://kafka-connect:8083"

echo "Waiting for Kafka Connect at ${CONNECT_URL}..."
until curl -sf "${CONNECT_URL}/connectors" >/dev/null; do
  sleep 2
done

echo "Kafka Connect is up. Substituting credentials from environment and registering connector..."

# Substitute the credential placeholders with the real values from the
# environment. Done in awk (ENVIRON + index/substr string ops, byte-faithful,
# no metacharacter interpretation at any layer) because sed replacement text
# interprets '&', '\', and its delimiter: a password containing a literal
# '\' or '"' (valid in a Postgres password) produced invalid JSON through a
# sed pipeline when tested live in this container image. Values are
# JSON-string-escaped before insertion so any character round-trips exactly.
# Mirrors the k8s path (k8s/20-kafka-connect.yaml): same __DB_USER__ /
# __DB_PASSWORD__ / __DB_NAME__ placeholders, same env-sourced values.
awk '
  {
    t = t $0 "\n"
  }
  END {
    user = ENVIRON["POSTGRES_USER"]
    pass = ENVIRON["POSTGRES_PASSWORD"]
    db = ENVIRON["POSTGRES_DB"]
    t = replace(t, "__DB_USER__", jsonescape(user))
    t = replace(t, "__DB_PASSWORD__", jsonescape(pass))
    t = replace(t, "__DB_NAME__", jsonescape(db))
    printf "%s", t
  }
  function jsonescape(s,   out, n, i, c) {
    out = ""
    n = length(s)
    for (i = 1; i <= n; i++) {
      c = substr(s, i, 1)
      if (c == "\\")  out = out "\\\\"
      else if (c == "\"") out = out "\\\""
      else if (c == "\n") out = out "\\n"
      else if (c == "\t") out = out "\\t"
      else if (c == "\r") out = out "\\r"
      else if (c == "\b") out = out "\\b"
      else if (c == "\f") out = out "\\f"
      else out = out c
    }
    return out
  }
  function replace(s, ph, val,   i, out) {
    while ((i = index(s, ph)) > 0) {
      out = out substr(s, 1, i - 1) val
      s = substr(s, i + length(ph))
    }
    return out s
  }
' /connector/postgres-connector.json > /tmp/postgres-connector.json

status=$(curl -s -o /tmp/register-response.json -w '%{http_code}' \
  -X POST "${CONNECT_URL}/connectors" \
  -H 'Content-Type: application/json' \
  -d @/tmp/postgres-connector.json)

if [ "$status" = "201" ] || [ "$status" = "409" ]; then
  echo "Connector registered (or already exists). HTTP $status"
  cat /tmp/register-response.json
  exit 0
fi

echo "Failed to register connector. HTTP $status"
cat /tmp/register-response.json
exit 1