#!/usr/bin/env bash
# Build snapdiff on the desktop and ship it to the VPS. Repeatable; this IS
# the deploy pipeline. Run from the snapdiff project root:
#
#   deploy/deploy.sh <vps-host-or-ip> [admin-user]
#
# What ships: dist/ (compiled), package.json, package-lock.json, watch-fids.txt.
# What never ships: .env (lives only on the VPS), data/, reports/, node_modules/.
# Production dependencies are installed ON the VPS from the lockfile, so the
# desktop's node_modules never cross the wire.
set -euo pipefail

HOST="${1:?usage: deploy/deploy.sh <vps-host-or-ip> [admin-user]}"
ADMIN_USER="${2:-schmrdty}"
APP_DIR="/srv/snapdiff"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
echo "== typecheck + build =="
npm run typecheck
npm run build

echo "== ship =="
rsync -az --delete \
  --exclude '.env' --exclude 'data/' --exclude 'reports/' --exclude 'node_modules/' \
  dist package.json package-lock.json watch-fids.txt \
  "${ADMIN_USER}@${HOST}:${APP_DIR}/"

echo "== install production deps + restart =="
ssh "${ADMIN_USER}@${HOST}" "cd ${APP_DIR} && npm ci --omit=dev --no-audit --no-fund && sudo systemctl restart snapdiff && sleep 2 && systemctl is-active snapdiff && curl -s -o /dev/null -w 'local dashboard: HTTP %{http_code}\n' http://127.0.0.1:8787/"

echo "== done =="
echo "Logs: ssh ${ADMIN_USER}@${HOST} 'journalctl -u snapdiff -n 50 -o cat --no-pager'"
