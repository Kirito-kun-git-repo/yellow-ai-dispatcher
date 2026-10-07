#!/usr/bin/env bash
# Apply schema.sql to the database in DATABASE_URL.
#
#   db/apply.sh            apply (fails if the objects already exist)
#   db/apply.sh --reset    drop every object this schema owns, then apply
#
# --reset exists because the test harness needs a known-empty database on every
# run. It drops by name rather than dropping the schema wholesale, so pointing
# this at the wrong database damages only objects this file created.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

: "${DATABASE_URL:?set DATABASE_URL, or copy .env.example to .env}"

psql_do() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q "$@"; }

if [ "${1:-}" = "--reset" ]; then
  echo "resetting schema in ${DATABASE_URL%%\?*}"
  psql_do <<'SQL'
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS tenant_limits;
DROP TYPE  IF EXISTS message_status;
DROP TYPE  IF EXISTS campaign_status;
DROP TYPE  IF EXISTS channel;
SQL
fi

psql_do -f schema.sql
echo "schema applied"
