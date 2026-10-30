# Client health

snapdiff compares two nodes. People do not use nodes; they use clients: Vibeshift, Quilcast, Quorum, and whatever comes next on either network. This optional feature shows, beside the node cards, whether each client's own status endpoint says it is up, with a link to the client's site. It is off unless you configure it.

It is a courtesy display, not a monitor of record: one status word per client, refreshed every minute, nothing stored across restarts.

## What a visitor sees

A "Clients" card with one row per configured client: the name (linked to the client's site, hostname shown), which network it serves, a status pill (`ok`, `degraded`, `down`, `unknown`), the last response time, when it was last checked, and a short note such as `HTTP 503` or `status "maintenance"`.

The same rows are at `GET /api/clients`.

## Safety contract

This feature calls third-party servers and renders links. These rules keep that from becoming a problem for you or for your visitors.

1. Every URL comes from your config file. Nothing in a response, a query string, or the page can change where the poller goes or where a link points. A health endpoint that returns a URL is ignored.
2. HTTPS only, no credentials in URLs, redirects refused (a redirect counts as down with the note `redirect refused`), 5 second timeout, response body capped at 16 KB.
3. The response is reduced to a status word from a fixed set plus a note built from fixed phrases and at most 40 characters of the status value. The raw body is never stored, logged, or rendered.
4. Labels are 1 to 40 printable ASCII characters and are escaped on render like everything else. Status pills render only from the fixed vocabulary; an unexpected value shows as `unknown`.
5. Links carry `rel="noopener noreferrer"`: the client's site cannot reach back into the visitor's tab, and your dashboard URL is not sent as the referrer.
6. The Caddyfile sets a Content-Security-Policy that forbids scripts and external assets on the page, so a rendering mistake cannot load or run anything from a third party.
7. A malformed config file is a startup error, not a silently empty card.

What the client's server sees: one GET a minute from the VPS address with an `accept` header and no cookies, no key, no identifying information. If a client ever requires a token, put it in the unit's `.env` the same way as the Neynar key and ask for the header to be added; it is not supported today.

## Config file

A JSON array. Put the real file outside the deployed tree (`/srv/snapdiff/data/clients.json` on the VPS; `deploy.sh` never touches `data/`). `clients.example.json` in the repo is a template with placeholders.

| Field | Required | Meaning |
|---|---|---|
| `label` | yes | Display name, 1 to 40 printable ASCII characters, unique |
| `network` | yes | `snapchain`, `hypersnap`, or `both` |
| `siteUrl` | yes | Where the link goes. `https://` only |
| `healthUrl` | no | Status endpoint. `https://` only. Omit for a link-only row (status stays `unknown`) |
| `statusPath` | no | Dot path to the status field in the JSON body, default `status`. `null` means any HTTP 200 counts as ok (for plain `/healthz` endpoints) |
| `okValues` | no | Values at `statusPath` that mean ok, case-insensitive. Default: ok, healthy, up, operational, pass, green |

How a check resolves:

| Response | Status | Note |
|---|---|---|
| 200 and the field is an ok value (or `true`, or `statusPath` is null) | ok | |
| 200 and the field is some other string or `false` | degraded | `status "<value>"` |
| Any non-2xx | down | `HTTP <code>` |
| Timeout, connection failure, or redirect | down | `timeout`, `unreachable`, `redirect refused` |
| 200 but no JSON, no field, or body over 16 KB | unknown | `not JSON`, `no status field`, `body too large` |

## Environment

| Name | Default | Meaning |
|---|---|---|
| `CLIENT_HEALTH_FILE` | empty (off) | Path to the clients JSON |
| `CLIENT_HEALTH_INTERVAL_SEC` | 60 | Seconds between check rounds (two clients checked at a time) |

## Turning it on (VPS)

1. Copy the template up and edit it:

   `scp clients.example.json snapdiff:/tmp/clients.json && ssh -t snapdiff 'sudo -u snapdiff cp /tmp/clients.json /srv/snapdiff/data/clients.json && rm /tmp/clients.json && sudo -u snapdiff nano /srv/snapdiff/data/clients.json'`

2. Point the unit at it and restart:

   `ssh snapdiff 'printf "CLIENT_HEALTH_FILE=/srv/snapdiff/data/clients.json\n" | sudo tee -a /srv/snapdiff/.env >/dev/null && sudo systemctl restart snapdiff && sleep 3 && sudo journalctl -u snapdiff -n 5 -o cat --no-pager | grep -E "clients|dashboard"'`

   Expected: `clients: N configured, checked every 60s`. A config error prints the reason and the unit exits; fix the file and restart.

3. Deploy the Caddyfile change once (the CSP header) with the normal runbook step 3, or copy it by hand: `scp deploy/Caddyfile snapdiff:/tmp/Caddyfile && ssh snapdiff 'sudo cp /tmp/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy'`.

Turning it off: remove or blank `CLIENT_HEALTH_FILE` and restart.

## Adding a client

Ask the client team for three things: their site URL, a public status URL, and what that URL returns when healthy. Fill one object in the config file, restart, and check the row. If they have no status endpoint yet, add the row without `healthUrl`; it shows as a link with status `unknown` until they publish one.

## Limits

1. No history. The card shows the latest check only. Restart resets every row to `unknown` until the first round completes (a few seconds).
2. No alerting. The log records status changes (`[clients] Quorum: ok -> down (HTTP 503)`); nothing pages anyone.
3. A client that publishes an HTML status page rather than JSON needs `"statusPath": null`, which reduces the check to "the page answers 200".

## Tests

`npm test` covers config validation (HTTPS only, no credentials, path shape, duplicates), every status outcome, the fixed-phrase failure notes, body clipping, and the monitor's change log. The checks run against a fake fetch; the suite never goes online.
