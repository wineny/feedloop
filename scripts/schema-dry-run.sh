#!/usr/bin/env bash
# Applies supabase/schema.sql to a throw-away local PostgreSQL to prove it stands up a fresh database.
# No Supabase account needed. Use it before pushing a migration, and in CI.
#
#   scripts/schema-dry-run.sh                 # uses the first `postgres` binary it can find
#   PGBIN=/opt/homebrew/opt/postgresql@15/bin scripts/schema-dry-run.sh
#
# What it fakes from Supabase (the only pieces the schema depends on):
#   - schema `auth` with `auth.uid()` (always NULL here — our RLS policies reference it)
#   - roles anon / authenticated / service_role (GRANT / REVOKE targets)
#   - schema `storage` with a bare `storage.buckets` table (20260925_01 creates the widget-shots bucket)
# Everything else is plain PostgreSQL 15+. Exit code 0 = the whole file applied with ON_ERROR_STOP.
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  for c in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@15/bin /usr/lib/postgresql/*/bin; do
    [ -x "$c/postgres" ] && PGBIN="$c" && break
  done
fi
[ -n "$PGBIN" ] && [ -x "$PGBIN/postgres" ] || { echo "no PostgreSQL server binary found — set PGBIN=/path/to/bin"; exit 2; }

PORT="${PORT_OVERRIDE:-55440}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/feedloop-schema-dryrun.XXXXXX")"
PSQL=("$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=127.0.0.1" -l "$DATA/server.log" -w start >/dev/null

"${PSQL[@]}" -d postgres -c "CREATE DATABASE feedloop_dryrun" >/dev/null
"${PSQL[@]}" -d feedloop_dryrun <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  public BOOLEAN NOT NULL DEFAULT false,
  file_size_limit BIGINT,
  allowed_mime_types TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

echo "applying supabase/schema.sql …"
"${PSQL[@]}" -d feedloop_dryrun -f supabase/schema.sql >/dev/null
TABLES=$("${PSQL[@]}" -d feedloop_dryrun -tA -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
FUNCS=$("${PSQL[@]}" -d feedloop_dryrun -tA -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")
echo "OK — schema.sql applied: $TABLES tables, $FUNCS functions in public"

# Optional extra checks: pass a SQL file as $1 (e.g. a guardrail scenario) and it runs against the fresh DB.
if [ "${1:-}" ]; then
  echo "running $1 …"
  "${PSQL[@]}" -d feedloop_dryrun -f "$1"
fi
