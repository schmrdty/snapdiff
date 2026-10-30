# snapdiff

Read-only comparator for two Farcaster-protocol nodes (Snapchain and Hypersnap). It asks both nodes for the same casts, diffs them by message hash, and tags every difference with a cause. Only one cause, `unexplained`, is worth investigating.

It never writes to either network. It only reads.

## Quick start (no real nodes needed)

1. `npm install`
2. Terminal 1: `npm run mock` (two fake nodes on :3381 and :4381)
3. Terminal 2: `SCAN_INTERVAL_MIN=0.1 RECHECK_AFTER_MIN=0.05 UNEXPLAINED_AFTER_MIN=0.3 WATCH_FIDS=1,2 npm run dev`
4. Open http://localhost:8787 and wait about 40 seconds.
5. Expected result: 5 sync_lag, 5 version_rule, 5 unexplained (all missing on snapchain), 1 relay_filtered (FID 6, registered on hypersnap only), and one stall on hypersnap shard 2 that starts about 30 s in and clears at about 150 s (set `BEHIND_BLOCK_DELAY=20` to see it sooner).

## Real nodes, without running any

You do not need your own nodes. snapdiff only needs the HTTP API, and both networks have public endpoints (verified 2026-10-24):

| Side | URL | Notes |
|---|---|---|
| Snapchain | `https://snapchain-api.neynar.com` | Needs `x-api-key`. Get a key at neynar.com; the docs placeholder `NEYNAR_API_DOCS` works for a quick test but is rate-limited (expect 429s). |
| Hypersnap | `https://haatz.quilibrium.com` | Canonical public node listed on hypersnap.org. No key. |

Other hubs listed on hypersnap.org (`hub.pinata.cloud`, `hub.farcaster.standardcrypto.vc`) could not be reached from the test environment; try them from your own machine.

1. `cp .env.example .env`, then set:
   ```
   NODE_A_URL=https://snapchain-api.neynar.com
   NODE_A_HEADERS={"x-api-key":"YOUR_KEY"}
   NODE_B_URL=https://haatz.quilibrium.com
   CONCURRENCY=2
   ```
2. Put the FIDs you care about in `watch-fids.txt` (one per line, `#` comments allowed).
3. Preflight: `npm run check-nodes -- 3`. Do not trust results until both nodes pass every line.
4. Run: `npm run build && node --env-file=.env --disable-warning=ExperimentalWarning dist/src/index.js`
5. Open http://localhost:8787.

Expected today, before the fork: zero diffs and zero stalls, because both nodes follow the same validators. The interesting output starts when one side falls behind or the networks split.

## Your own nodes

Run each node on its own machine (both default to ports 3381-3383, and a Snapchain node needs about 2 TB of disk), then point `NODE_A_URL` and `NODE_B_URL` at them. Everything else is the same as above.

## How it works

| Loop | Default interval | What it does |
|---|---|---|
| info | 60 s | Polls `/v1/info` on both nodes. Stores shard heights and worst `blockDelay`. |
| scan | 15 min | For watchlist FIDs plus `SAMPLE_SIZE` random FIDs, fetches casts from the last `LOOKBACK_HOURS` on both nodes. Records every hash present on one side only. |
| recheck | 60 s | For open diffs older than `RECHECK_AFTER_MIN`, asks the missing node for that exact hash via `/v1/castById`, then classifies. |

## Causes

| Cause | Meaning | Action |
|---|---|---|
| `sync_lag` | Arrived on the missing side later. | None. Expected. |
| `relay_filtered` | The relay between the networks does not carry it by design: its message type is in `RELAY_FILTERED_TYPES`, or its FID has no ID registration on the missing node (a FID registered on one network only). | None. Expected. |
| `version_rule` | Uses V22 fields (`chain`, `formatVersion`) or exceeds the V21 text limit. One rule set accepts it, the other does not. | None. Expected. |
| `pending` | Too new, recheck failed, or the missing node is behind (`blockDelay` above `BEHIND_BLOCK_DELAY`) or unreachable. | Wait. |
| `unexplained` | Valid under both rule sets, still missing after `UNEXPLAINED_AFTER_MIN`. | Investigate. |

`unexplained` rows keep being rechecked for `RECHECK_WINDOW_HOURS`, so a very late arrival still flips to `sync_lag`.

## The relay model (after the Hypersnap fork)

Once Hypersnap moves to its own validators and its own mempool topic, nothing crosses between the networks except through a relay process. The relay filters by message type: channel messages do not cross in either direction, and Hypersnap-only features (mini apps, on-network FIDs, and anything an on-network FID signs) do not cross to Snapchain. A message that both networks accept but that never crossed is a relay failure, and that is what `unexplained` means in this mode.

snapdiff handles the two filter rules separately:

1. **Message type.** Set `RELAY_FILTERED_TYPES` to the comma-separated list of message type names the relay skips, once the relay code names them. Until then it is empty and the rule never fires.
2. **FID origin.** Before calling a diff `unexplained`, snapdiff asks the missing node `/v1/onChainEventsByFid?event_type=EVENT_TYPE_ID_REGISTER` for the FID. No registration means nothing that FID signs can ever appear there, so the diff is `relay_filtered`. One request per FID per recheck run, cached. Set `FID_ORIGIN_CHECK=0` to disable.

Today, before the fork, both nodes follow the same validators and the same `mempool` topic, so there is no relay and these rules mostly stay quiet.

## Shard stalls

Snapchain splits FIDs across data shards (`shard = SHA256(fid)[0..4] % numShards + 1`, the same rule in upstream Snapchain and Hypersnap). When a node cannot validate a shard's blocks, for example after a version cutover it has not shipped yet, that one shard stops advancing while the others keep going. Users on the stuck shard see their posts vanish from that node; users on the other shard notice nothing.

snapdiff records each of these as a stall event:

| Field | Meaning |
|---|---|
| `side`, `shardId` | Which node, which shard |
| `startedAt`, `endedAt` | Wall-clock bounds; `endedAt` is null while ongoing |
| `stuckHeight` | The shard's height on the stalled node when the stall was first seen |
| `peerHeightStart`, `peerHeightEnd` | How far the other node's copy of that shard got |
| `maxBlockDelay` | Worst `blockDelay` observed during the stall |

Detection rule: a shard's `blockDelay` on one node is above `BEHIND_BLOCK_DELAY` (default 50 s) while the same shard on the other node is at or below it. Both nodes slow on the same shard is a network slowdown, not a stall, and is not recorded. `blockDelay` is `now - newest block timestamp` per shard, so a stuck shard's delay climbs one second per second and crosses the threshold within a minute.

Every diff is tagged with its FID's shard. During a stall, diffs whose missing side is the stalled node on that shard stay `pending`; diffs on the healthy shard are still judged. `npm run check-nodes` verifies the shard function against the node's own `/v1/events` (every merged message on shard S must hash to S) so a transcription error cannot silently mis-tag.

Stalls appear on the dashboard, at `GET /api/stalls`, and in the daily report.

## Known false positives (check these before calling anything censorship)

1. Cast deletes. `castsByFid` returns live casts only. If a `CastRemove` reached one node but not the other, the cast shows as a diff.
2. Storage pruning. An account over its storage limit gets old messages pruned. Nodes can prune at slightly different moments.
3. Rule changes after v0.15.0. `src/classify.ts` only knows V21 and V22. Add new rules there when either network ships a new version.
4. Hypersnap API drift. Hypersnap is assumed to serve the same HTTP API as Snapchain. `npm run check-nodes` verifies this; rerun it after every Hypersnap upgrade.

A one-sided fetch failure never creates a diff. The FID is skipped for that scan and counted in `errors`.

## Daily report and attestation

1. `npm run report -- 2026-10-24` (defaults to yesterday, UTC)
2. Writes `reports/<day>.json` as canonical JSON (sorted keys) and prints its keccak256.
3. Commit that hash with your attestation CLI. Anyone can later rebuild the report from the same database and confirm the hash matches.

## API

| Route | Returns |
|---|---|
| `GET /` | Dashboard (auto-refresh 30 s) |
| `GET /api/summary` | Counts by cause, latest node info |
| `GET /api/diffs?cause=unexplained&limit=200` | Diff rows with the full message JSON and shard |
| `GET /api/stalls?limit=200` | Shard stall events, newest first |

## Moving to SpacetimeDB later

All storage goes through the `Store` interface in `src/store/store.ts`.

1. Implement `src/store/spacetime.ts` (layout is documented in that file: the poller calls reducers, and the dashboard subscribes).
2. Change the one `new SqliteStore(...)` line in `src/index.ts`.

Portability back to SQLite: SpacetimeDB has no export or dump command (`spacetime sql --format json` is the closest). Keep the SpacetimeDB tables column-for-column identical to `SCHEMA` in `src/store/sqlite.ts`, and an `export` command is a loop that reads every row through one `Store` and writes it through the other. Types map directly: `u64` and `i64` to INTEGER, `String` to TEXT, `bool` to INTEGER 0/1, `Option<T>` to NULL. Store times as `u64` milliseconds rather than SpacetimeDB's `Timestamp` (microseconds) so no conversion is needed.

## Watchlist

FIDs that are scanned on every run, on top of `SAMPLE_SIZE` random ones. Two ways to supply them; both accept commas, spaces, or one per line, and `#` comments:

1. `WATCH_FIDS=3,5650,239` in the environment.
2. `WATCH_FIDS_FILE=/path/to/watch-fids.txt`, a plain text file. The `watch-fids.txt` in this repo is an empty example.

On a deployed server keep the real list outside the deployed tree (for example in `data/`, see `deploy/README.md`), so a redeploy does not overwrite it and the roster never enters version control. Only add an account with its owner's say-so: the dashboard and `/api/diffs` show each watched account's diffs, including cast text, to anyone who can open the page.

## Config

See `.env.example`. Every value has a default. Sizing the net: with the defaults (24-hour lookback, 50 random FIDs) most scans see zero casts, because most of the 3.3 million FIDs are dormant. `LOOKBACK_HOURS=168` and `SAMPLE_SIZE=200` plus a watchlist give every scan something to compare, at the cost of more API calls (`CONCURRENCY` throttles them).

## Client health (optional)

Shows whether the apps people use on each network (Vibeshift, Quilcast, Quorum, and others) report themselves healthy, with a link to each one's site. Off unless `CLIENT_HEALTH_FILE` names a config; every URL is yours, nothing from a response ever becomes a link or text on the page. Details, config format, and the safety contract: `docs/CLIENT-HEALTH.md`.

## Deploying

`deploy/` holds a tested kit for a standalone Ubuntu VPS: an idempotent bootstrap (key-only SSH, firewall, Node 24, locked app user, systemd unit, Caddy with automatic TLS) and a desktop-side build-and-rsync deploy script. Runbook in `deploy/README.md`. `scripts/probe-window.mjs` checks what the two nodes return for given FIDs in the scan's own time window; useful when the dashboard shows nothing.

## Requirements

Node 22.5 or newer (uses the built-in `node:sqlite`, so there are no native modules to compile).

## Files

| Path | Purpose |
|---|---|
| `src/hub.ts` | Raw-fetch client for the node HTTP API |
| `src/classify.ts` | Hash diff, V21/V22 rule detection, cause classification (pure functions) |
| `src/shard.ts` | FID to data-shard routing, transcribed from `routing.rs` |
| `src/stall.ts` | Shard-stall detection and per-shard "behind" gate (pure functions) |
| `src/loops.ts` | info (plus stall tracking), scan, recheck loops |
| `src/store/sqlite.ts` | SQLite schema and store |
| `src/server.ts` | Hono dashboard and JSON API |
| `src/clients.ts` | Optional client status checks (`docs/CLIENT-HEALTH.md`) |
| `src/report.ts` | Daily canonical report and hash |
| `scripts/check-nodes.ts` | Preflight compatibility check |
| `scripts/mock-hubs.ts` | Two fake nodes with seeded scenarios |
| `scripts/probe-window.mjs` | Diagnostic: cast counts per node for given FIDs in the scan window vs 30 days |
| `deploy/` | VPS bootstrap, systemd unit, Caddyfile, deploy script, runbook |
| `test/` | Unit tests (`npm test`) |
