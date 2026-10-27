# Deploying snapdiff to a standalone Cherry VPS

One small box runs snapdiff behind Caddy with automatic TLS. snapdiff only
reads two public Farcaster node APIs, so the server needs no tunnel, no
inbound ports beyond SSH and HTTPS, and no connection to any home machine.

Sizing: the smallest Cherry VPS (1 vCore, 1 GB, 20 GB) is enough. The SQLite
database grows with diffs, which are rare; reports are a few KB a day.

## Order checklist (Cherry portal)

| Setting | Value |
|---|---|
| Type | VPS, smallest plan (1 vCore / 1 GB / 20 GB) |
| Region | Any; the app is latency-insensitive. Same region as the games edge keeps the account simple |
| Image | Ubuntu 24.04 LTS |
| SSH key | `cherry` (the key already on the account; its public half is `~/.ssh/cherry.pub` on the desktop) |
| Extras | None (no backups add-on needed; data is regenerable, reports are hashed) |

Write down the IPv4 address the portal shows. Everything below uses `<IP>`.

## Runbook (each step is one paste-safe line, run from the desktop)

1. First contact, as root, with the Cherry key (also pins the host key):

   `ssh -i ~/.ssh/cherry root@<IP> 'hostname && cat /etc/os-release | head -2'`

2. Ship this folder:

   `scp -i ~/.ssh/cherry -r deploy root@<IP>:/root/snapdiff-deploy`

3. Bootstrap (admin user, key-only SSH, firewall, Node 24, app user, unit, Caddy):

   `ssh -i ~/.ssh/cherry root@<IP> 'chmod +x /root/snapdiff-deploy/*.sh && ADMIN_USER=schmrdty /root/snapdiff-deploy/setup-vps.sh'`

   If it prints "NO key found", add the key and re-run step 3:

   `ssh -i ~/.ssh/cherry root@<IP> 'install -d -m700 /home/schmrdty/.ssh && cat > /home/schmrdty/.ssh/authorized_keys && chown -R schmrdty:schmrdty /home/schmrdty/.ssh && chmod 600 /home/schmrdty/.ssh/authorized_keys' < ~/.ssh/cherry.pub`

4. Passwordless login from here on. Add this to `~/.ssh/config` on the desktop so plain `ssh snapdiff` works and deploy.sh needs no `-i`:

   `printf '\nHost snapdiff\n  HostName <IP>\n  User schmrdty\n  IdentityFile ~/.ssh/cherry\n  IdentitiesOnly yes\n' >> ~/.ssh/config && ssh snapdiff 'whoami && sudo -n true && echo sudo-ok'`

   Root login and password auth are now off; `ssh root@<IP>` is expected to fail from here.

5. DNS: add `A snapdiff -> <IP>` for schmidtiest.xyz. If the zone is on Cloudflare, leave the record DNS-only (grey cloud) so Caddy can complete its TLS challenge on ports 80/443. Check: `dig +short snapdiff.schmidtiest.xyz`.

6. Config on the VPS. The env file exists, empty, owned by the app user. Fill it (the Neynar key goes here and nowhere else):

   `ssh snapdiff 'sudo tee -a /srv/snapdiff/.env >/dev/null' <<< 'NODE_A_URL=https://snapchain-api.neynar.com'`

   Repeat for `NODE_A_HEADERS={"x-api-key":"..."}`, `NODE_B_URL=https://haatz.quilibrium.com`, `CONCURRENCY=2`, and any tuning from `.env.example`. Or edit it in place: `ssh -t snapdiff 'sudo nano /srv/snapdiff/.env'`.

7. Deploy (builds here, ships, installs prod deps there, restarts, checks):

   `deploy/deploy.sh snapdiff`

8. Prove it:

   `curl -s -o /dev/null -w '%{http_code}\n' https://snapdiff.schmidtiest.xyz/ && curl -s https://snapdiff.schmidtiest.xyz/api/summary | head -c 300`

9. Preflight against the real nodes (same command the README documents, run on the VPS where the env lives):

   `ssh snapdiff 'cd /srv/snapdiff && sudo -u snapdiff env $(sudo cat .env | xargs) node --disable-warning=ExperimentalWarning dist/scripts/check-nodes.js 3'`

Repeat step 7 after every code change. Step 3 is safe to re-run.

## Operations

| Do | Command |
|---|---|
| Status | `ssh snapdiff 'systemctl is-active snapdiff caddy'` |
| Logs, live | `ssh snapdiff 'journalctl -u snapdiff -f -o cat'` |
| Restart | `ssh snapdiff 'sudo systemctl restart snapdiff'` |
| Daily report + hash (UTC yesterday) | `ssh snapdiff 'cd /srv/snapdiff && sudo -u snapdiff node --disable-warning=ExperimentalWarning dist/src/report.js'` |
| Pull the database for local analysis | `rsync -az snapdiff:/srv/snapdiff/data/snapdiff.db ./data/vps-snapdiff.db` |
| Password-gate the dashboard | uncomment `basic_auth` in `/etc/caddy/Caddyfile` on the VPS, paste a `caddy hash-password` hash, `sudo systemctl reload caddy` |

## Security notes

1. SSH is key-only; root login and passwords are disabled once the admin key is in place. `ufw limit` rate-limits port 22.
2. The unit runs as a locked system user with `ProtectSystem=strict`; it can write only `data/` and `reports/`.
3. The only secret on the box is the Neynar API key in `/srv/snapdiff/.env` (mode 640, app user). It never leaves the VPS and never enters this repo (`.env` is gitignored).
4. Caddy keeps no access logs. The dashboard serves read-only data about two public networks.
5. Nothing on this box knows any home address. There is no tunnel.
