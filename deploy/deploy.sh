#!/usr/bin/env bash
# Build snapdiff on the desktop and ship it to the VPS. Repeatable; this IS
# the deploy pipeline. Run from the snapdiff project root:
#
#   deploy/deploy.sh <vps-host-or-ip> [admin-user]
#
# What ships: dist/ (compiled), package.json, package-lock.json.
# What never ships: .env (lives only on the VPS), data/, reports/, node_modules/, and
# watch-fids.txt: the repo copy is an empty example, the real list lives in data/ on the
# VPS (WATCH_FIDS_FILE). Shipping the example put an empty decoy next to the app and it
# looked like the list had been wiped on every deploy (operator, 2026-11-11).
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
npm audit --omit=dev --audit-level=high
npm run build

echo "== ship =="
rsync -az --delete \
  --exclude '.env' --exclude 'data/' --exclude 'reports/' --exclude 'node_modules/' \
  dist static package.json package-lock.json \
  "${ADMIN_USER}@${HOST}:${APP_DIR}/"

echo "== install production deps + restart =="
# After the restart the node process needs a few seconds to open the database and listen, so
# the check waits 5 s, then retries every 5 s for up to 30 s. A single immediate curl printed
# "HTTP 000" on every deploy while the service was in fact fine (operator, 2026-11-18).
ssh "${ADMIN_USER}@${HOST}" "cd ${APP_DIR} && npm ci --omit=dev --no-audit --no-fund && sudo systemctl restart snapdiff && sleep 5 && systemctl is-active snapdiff && for i in 1 2 3 4 5 6; do code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/); if [ \"\$code\" = 200 ]; then echo \"local dashboard: HTTP 200 after \$((i*5)) s\"; exit 0; fi; sleep 5; done; echo \"local dashboard: HTTP \$code after 35 s, check: sudo journalctl -u snapdiff -n 30\"; exit 1"

echo "== done =="
echo "Logs: ssh ${ADMIN_USER}@${HOST} 'journalctl -u snapdiff -n 50 -o cat --no-pager'"
