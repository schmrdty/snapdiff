# snapdiff ops runbook

One-line commands only. Each says where it runs. Nothing here edits an `.env` file or prints a secret. The ssh alias `snapdiff` is the VPS that runs the dashboard and the bot. Commands marked "repo root" run from the snapdiff checkout on the desktop. Source for these lines: `deploy/README.md`, `integrations/telegram/README.md`, and the deploy script header; when they change, change this file.

## Look

| Do | Where | Command |
|---|---|---|
| Is everything up | anywhere | `ssh snapdiff 'systemctl is-active snapdiff caddy snapdiff-telegram'` |
| App logs, last 50 lines | anywhere | `ssh snapdiff 'journalctl -u snapdiff -n 50 -o cat --no-pager'` |
| Bot logs, last 20 lines, commands handled | anywhere | `ssh snapdiff 'sudo -n journalctl -u snapdiff-telegram -n 20 -o short-iso --no-pager'` |
| Live summary, versions per node | anywhere | `curl -s https://snapdiff.schmidtiest.xyz/api/summary \| python3 -I -c 'import json,sys;d=json.load(sys.stdin);[print(k,v and v.get("version"),v and v.get("reachable"),v and v.get("maxBlockDelay")) for k,v in d["info"].items()]'` |
| Open stalls | anywhere | `curl -s 'https://snapdiff.schmidtiest.xyz/api/stalls?limit=20'` |
| One node over 24 h | anywhere | `curl -s 'https://snapdiff.schmidtiest.xyz/api/node/ohsnap?hours=24'` |
| Watchlist size the server read at start | anywhere | `ssh snapdiff 'sudo journalctl -u snapdiff -n 200 -o cat --no-pager \| grep watchlist \| tail -1'` |

## Change

Back up first, every time. The restore line is the same command with the two paths swapped.

| Do | Where | Command |
|---|---|---|
| Restart the app | anywhere | `ssh snapdiff 'sudo systemctl restart snapdiff'` |
| Restart the bot | anywhere | `ssh snapdiff 'sudo systemctl restart snapdiff-telegram'` |
| Edit the watchlist, then restart | anywhere | `ssh -t snapdiff 'sudo -u snapdiff cp -p /srv/snapdiff/data/watch-fids.txt /srv/snapdiff/data/watch-fids.txt.bak-$(date +%F) && sudo -u snapdiff nano /srv/snapdiff/data/watch-fids.txt && sudo systemctl restart snapdiff'` |
| Deploy the app after a code change | repo root | `npm run typecheck && npm test && deploy/deploy.sh snapdiff` |
| Check and test the bot | repo root | `cd integrations/telegram && npm run check && npm test` |
| Deploy the bot after a code change | repo root | `rsync -a --delete --exclude node_modules integrations/telegram/ snapdiff:/tmp/snapdiff-telegram/ && ssh snapdiff 'sudo rsync -a --delete --exclude node_modules /tmp/snapdiff-telegram/ /opt/snapdiff-telegram/ && sudo chown -R snapdiff-bot:snapdiff-bot /opt/snapdiff-telegram && sudo systemctl restart snapdiff-telegram && sleep 4 && sudo systemctl is-active snapdiff-telegram'` |
| Daily report and its hash (UTC yesterday) | anywhere | `ssh snapdiff 'cd /srv/snapdiff && sudo -u snapdiff node --disable-warning=ExperimentalWarning dist/src/report.js'` |
| Pull the database for local analysis | repo root | `rsync -az snapdiff:/srv/snapdiff/data/snapdiff.db ./data/vps-snapdiff.db` |

Env edits (adding a node, a header, a tuning value) are done by Ryan in `/srv/snapdiff/.env` on the VPS, followed by `sudo systemctl restart snapdiff`. The project hands him the exact lines; it never reads the file. Adding a node is a handoff to a Claude Code session because `NODES` ordering and the relabel rule in `docs/MULTI-NODE.md` matter.

Clients file: `/srv/snapdiff/data/clients.json`, one JSON array. A parse error exits the whole unit at startup, so validate before restarting: `ssh snapdiff 'python3 -I -c "import json;json.load(open(\"/srv/snapdiff/data/clients.json\"))" && echo ok'`.

## Never

1. Never run a second copy of a unit by hand. `systemctl restart` only.
2. Never `systemctl reload caddy` on this VPS; the Caddyfile sets `admin off`. Use `restart`.
3. Never run `npm run check-nodes` from a home machine; it probes every node directly. Run the compiled copy on the VPS: `ssh snapdiff 'cd /srv/snapdiff && sudo -u snapdiff node --env-file=/srv/snapdiff/.env --disable-warning=ExperimentalWarning dist/scripts/check-nodes.js 3'`.
4. Never ship `.env`, `data/`, or `watch-fids.txt` with a deploy. The deploy script already excludes them; do not add flags.
5. Never commit without being asked, and never rewrite history.

## When the VPS refuses SSH

The VPS sshd sometimes refuses a burst of connections ("Connection refused" on port 22). Wait a minute and retry. Bundle several checks into one `ssh snapdiff '... && ...'` rather than several connections.

## Known shapes of "down" that are not down

1. A node card red for one check with an error and healthy before and after: a single timeout or a 502 at the provider. The 24 h window on `/api/node/LABEL` shows one down sample.
2. A node whose `/v1/info` takes longer than 10 s answers "down" while the path is fine. Time it from the VPS: `ssh snapdiff 'curl -s -o /dev/null -w "%{time_total}\n" https://ohsnap.schmidtiest.xyz/v1/info'`.
3. Every Hypersnap node stalled on the same shard at the same height: a consensus pause, scope `network`, nothing to restart.
