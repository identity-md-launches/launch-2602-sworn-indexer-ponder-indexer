#!/bin/sh
# One start path for Compose, Railway and a person running it by hand.
# Schema: DATABASE_SCHEMA, else Railway's per-deploy id, else the id baked into the
# image at build time (a rebuilt image indexes into a fresh schema, a restarted
# container resumes in its own), else "public".
set -e
cd "$(dirname "$0")/.."
schema="${DATABASE_SCHEMA:-${RAILWAY_DEPLOYMENT_ID:-$(cat .build-id 2>/dev/null || echo public)}}"
views="${PONDER_VIEWS_SCHEMA:-sworn_indexer}"
echo "sworn-indexer: schema=$schema views=$views database=$( [ -n "${DATABASE_PRIVATE_URL:-$DATABASE_URL}" ] && echo postgres || echo "pglite:${PGLITE_DIRECTORY:-.ponder/pglite}" ) port=${PORT:-42069}"
if [ "$views" = "$schema" ] || [ "$views" = "off" ]; then
  exec ./node_modules/.bin/ponder start --schema "$schema"
fi
exec ./node_modules/.bin/ponder start --schema "$schema" --views-schema "$views"
