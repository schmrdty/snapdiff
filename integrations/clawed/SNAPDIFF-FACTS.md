# snapdiff facts, as of 2026-11-13

Everything here was read from the running deployment, the repo, or the upstream Hypersnap repo on that date. When the repo docs disagree with this file, the repo wins and this file needs an edit.

## What snapdiff is

A read-only comparator. Every minute it polls `/v1/info` on every configured node. Every 15 minutes it fetches recent casts for the watchlist FIDs plus a random sample, merges them into one presence picture per FID, and records one row per cast per node that lacks it. Every minute it rechecks open rows and assigns a cause. It never writes to any network and holds no keys for either network.

Public: dashboard at https://snapdiff.schmidtiest.xyz, JSON under `/api`, an agent-readable summary at `/llms.txt`, a Telegram bot at https://t.me/snapdiff_bot. Source: https://github.com/schmrdty/snapdiff (MIT).

## This deployment

| Label | Network | Shown as | Notes |
|---|---|---|---|
| snapchain | snapchain | snapchain | Reference node. Merkle's public node |
| hypersnap | hypersnap | haatz | Hypersnap reference. Validator operator's public node |
| imgnai | hypersnap | imgnai | |
| ohsnap | hypersnap | ohsnap | Ryan's read node, public at ohsnap.schmidtiest.xyz. A read node, not a validator |
| rainonme | hypersnap | rainonme | |
| sizzle | hypersnap | sizzle | |
| hypersnape.node | hypersnap | snape | Private address, label only |
| castrater | hypersnap | castrater | Private address, label only |
| homiehouse | hypersnap | homiehouse | Private address, label only. Was resyncing shard 0 from scratch on 2026-11-13 |

Watched clients (`/api/clients`): OpenCaster and Vibeshift, both on hypersnap. Client health is a courtesy display from each client's own status URL, not a monitor of record.

Versions on 2026-11-13 evening: snapchain 0.16.0; hypersnap nodes 0.17.7 except imgnai on 0.17.6. The version-drift rule compares each node to the newest version any reachable node of its own network reports, so one early upgrader makes everyone else "behind" for a while. That is a notice, not a fault.

## API

| Route | What to read |
|---|---|
| `/api/summary` | `nodes`, `networks`, `info[label]` (reachable, maxBlockDelay, shards with maxHeight and blockDelay, version, provider), `versions[network]`, `summary.openStalls`, `summary.byCause`, `summary.byScope`, `summary.networkSplit` |
| `/api/stalls?limit=200` | Stall rows, newest first: side, shardId, startedAt, endedAt (null while open), stuckHeight, scope, peer |
| `/api/node/LABEL?hours=24` | One node: latest snapshot, version with `behind`, 24 h window (samples, uptimePct, worstDelay, stalls), its stalls, history |
| `/api/diffs?cause=unexplained&limit=200` | Diff rows with message JSON, shard, presentNodes, missingOn, scope, cause |
| `/api/clients` | Client health rows |

All GET, no key, JSON. Limits: diffs max 5000, node window 1 to 168 hours.

## Reading blockDelay

`blockDelay` is computed inside each node, in its own `/v1/info` handler: current time minus the timestamp of that shard's newest block. It is not a comparison between networks and not something snapdiff invents. A stuck shard's delay climbs one second per second. A healthy node shows 0 to a few seconds.

## Reading stalls

A stall is one node's shard with blockDelay over `BEHIND_BLOCK_DELAY` (50 s) while a healthier peer exists.

| scope | Meaning | Measured against | Who to look at |
|---|---|---|---|
| `node` | That node alone is behind on that shard | The healthiest node of its own network | That node's operator |
| `network` | Every reachable node of the network is over the threshold on that shard: the network stopped deciding blocks | The healthiest node of the other network | The validators, not any read node |
| `null` | Row from before 2026-11-12 | n/a | History only |

Nothing is recorded when no node anywhere is healthy. An open row flips scope when its network recovers around it or stops around it. The dashboard shows a network scope as one network-wide pill; the bot words it once per chat as "NETWORK: shard N stopped on every node (network-wide pause)".

Since the 2026-11-12 fork the two networks run at different block rates (about 0.98 blocks/s on Snapchain, about 0.61 on Hypersnap), so shard heights are not comparable across networks. Only delays are.

## Reading diffs

| scope | Meaning |
|---|---|
| `node` | Another node on the same network has the cast. That node is behind or broken |
| `network` | Every node of that network lacks it. The networks disagree, or the shuttle has not relayed it yet |

| cause | Meaning | Action |
|---|---|---|
| `sync_lag` | Arrived later | None |
| `relay_filtered` | The shuttle does not carry it by design: filtered message type, or a FID that exists on one network only | None |
| `version_rule` | One rule set accepts it, the other does not | None |
| `pending` | Too new, the missing node is behind or unreachable, or the recheck failed | Wait |
| `unexplained` | Valid under both rule sets, still missing after the grace period | Investigate |

Observed shuttle lag after the fork: 30 to 45 minutes for a cast to appear on the other network. Rows sit at `pending`, then flip to `sync_lag`.

False positives to rule out before any stronger word: cast deletes (castsByFid shows live casts only), storage pruning, a rule change neither network has told snapdiff about, and Hypersnap API drift after an upgrade.

## The 2026-11-12 fork, in snapdiff terms

1. Hypersnap moved to its own validator set and its own gossip topics at shard 0 height 50,477,529 (about 20:52 UTC). Snapchain nodes do not relay the new topics, so a Hypersnap node whose bootstrap peers are all Snapchain nodes stalls at the last pre-fork block. The fix is Hypersnap peers in `bootstrap_peers`, as `/ip4/` entries.
2. Hypersnap ported native registration only: FIDs from 2^32 (4,294,967,296) up, assigned by shard 0 validators, proof of work at 22 bits, no token, staking, election, or Falcon signatures. Legacy FIDs below 2^32 still come from the same Optimism IdRegistry on both networks, so they cannot collide and work on both.
3. Native FIDs arrive in JSON as decimal strings. snapdiff reads them as numbers, routes them to shards with the native key (four zero bytes then 8 bytes), and asks `/v1/nativeAccount?fid=` for origin. A native cast missing on Snapchain is `relay_filtered` by design: the shuttle never relays native accounts. Random sampling stays below the legacy registration count, so a native account is scanned only when it is on the watchlist. No native account existed on 2026-11-13.
4. Hypersnap pauses seen on 2026-11-13 (85 s at 23:36 UTC on all shards; shard 0 halts from 00:20 and 00:41 UTC) were proposer slots of unreachable validators. They show as scope `network` rows and end on their own. They continue until every validator is reachable. Lowering quorum is not a fix: it would allow conflicting commits.
5. Upstream Hypersnap builds its libp2p swarm with TCP and QUIC and no DNS transport, so a `/dns4/` peer entry is never dialed. Peer entries must be `/ip4/`.
6. Hypersnap 0.17.6 added peer discovery (`[gossip.discovery]` in validators.toml, Kademlia and identify). A read node on it gains peers beyond its bootstrap list; failed dials to home addresses in its log are normal.

## Telegram bot

Commands: `/snapdiff` (add "is X down" for one node or client), `/status`, `/fid 123`, `/node LABEL`, `/subscribe LABEL` and `/unsubscribe` (private chat only), `/feedback text`, `/tip`, `/help`.

Group Privacy is on and stays on. In a group Telegram delivers only `/command@snapdiff_bot`, a bare `/command` when the bot posted last, and replies to the bot's messages. A plain `@snapdiff_bot` in free text is not delivered. Arguments follow the suffix: `/node@snapdiff_bot ohsnap`. A reply to the bot is answered only when it contains the word snapdiff, "is X down", "missing cast", "cast not showing", "help", "stop", or "feedback:". Other reply text is ignored.

`/fid` accepts any FID but only knows about FIDs snapdiff scanned: watchlist FIDs always, random legacy FIDs sometimes, native FIDs never unless watchlisted. "No open diffs in the latest N rows" for an unwatched FID means not scanned, not healthy.

Subscriptions: per private chat, up to a few nodes; events are down, back up, shard stall and recovery (network-wide worded once), left behind after a network pause, and version behind (again when the newest moves further ahead while the node is still behind) or current. Checked once a minute, one message per event type per 10 minutes. Replies to commands are spaced one per user per 12 s.

The bot stores no message text. It logs timestamps, command names, and generic errors only.

## Operator-side facts that are safe to state

1. snapdiff runs on a small VPS behind Caddy with automatic TLS. It needs no inbound port besides SSH and HTTPS and no connection to any home machine.
2. The bot runs as its own systemd unit on the same VPS and reads only the public API.
3. ohsnap is a read node fronted by a separate VPS. Its operator address is public; nothing about where the node physically runs is.
4. The watchlist lives on the server only; the repo copy is an empty example.
