#!/usr/bin/env bash
# Sets up a fresh Claude Code cloud session (or any clean clone) to check,
# test and migrate TEops. Safe to run more than once.
# Usage: bash scripts/cloud-setup.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Node $(node -v) (repo expects $(cat .nvmrc))"

echo "== App dependencies"
npm ci --no-audit --no-fund

echo "== SQL parser for npm run check (not part of the Netlify build)"
npm install --no-save --no-audit --no-fund libpg-query

echo "== Supabase CLI"
if ! command -v supabase >/dev/null 2>&1; then
  npm install -g supabase --no-audit --no-fund || {
    echo "npm global install failed, using npx supabase instead"
  }
fi
SUPA="supabase"
command -v supabase >/dev/null 2>&1 || SUPA="npx --yes supabase"
$SUPA --version

echo "== Link to Supabase (needs SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SUPABASE_DB_PASSWORD)"
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" && -n "${SUPABASE_PROJECT_REF:-}" && -n "${SUPABASE_DB_PASSWORD:-}" ]]; then
  $SUPA link --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"
  echo "Linked to $SUPABASE_PROJECT_REF"
else
  echo "Skipped: Supabase env vars not set (see docs/ENV_VARS.md)"
fi

echo "== Syntax check"
npm run check

echo "Done."
