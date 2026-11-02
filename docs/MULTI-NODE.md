# Comparing more than two nodes

snapdiff started as a two-node comparator (`a` vs `b`). From v0.5.0 it takes any number of nodes. This page covers how the comparison works with N nodes, how to configure it, what changed in the API, and what happens to an existing database.

## Model

Every node belongs to a **network** (`snapchain` or `hypersnap`). For each scanned FID, the casts returned by every node that answered are merged into one presence picture: hash, and the list of nodes that have it. Every answering node that lacks a hash gets one diff row, and that row carries a **scope**:

| Scope | Meaning | Who to look at |
|---|---|---|
| `node` | Another node on the missing node's own network has the cast. | That node: it is behind or broken. |
| `network` | Every answering node on the missing node's network lacks the cast. | The networks disagree (or the network has only one node, which then speaks for it). |

So with snapchain (1 node) and hypersnap (3 nodes):

- Cast on all three Hypersnap nodes, not on Snapchain: one row, `missingOn = snapchain`, `scope = network`, `presentNodes = [haatz, opencaster, ohsnap]`.
- Cast on Snapchain, missing on all three Hypersnap nodes: three rows, each `scope = network`. The Network split card counts that as one disagreement (distinct hash per network).
- Cast on Snapchain and two Hypersnap nodes, missing on ohsnap: one row, `scope = node`.

Each row is independent: a cast missing on two nodes is two rows, rechecked and classified on their own, because nodes catch up at different times. The dedupe key is `(hash, missingOn)`; the same cast reported again by a later scan is not a new row. Scope and `presentNodes` are judged when the row is first written, from the nodes that answered on that scan; a node whose fetch failed is unknown for that FID, gets no rows, and is not counted as a peer. A FID with fewer than two answers is skipped.

The **reference** node (`REFERENCE_NODE`) is now only an anchor: it is the `presentOn` value when it had the cast, and it is tagged on its dashboard card. It does not define what a diff means.

**Shard stalls** are measured per node against the healthiest reachable peer on that shard (lowest `blockDelay`), across networks. A node is stalled on a shard when its delay is over `BEHIND_BLOCK_DELAY` and that peer's delay is not. The stall row records which peer it was measured against. If every node is slow on a shard, nobody is stalled (network slowdown). When every node of one network is stalled on the same shard the dashboard marks it network-wide.

## Configuration

```
NODES=snapchain,haatz,opencaster,ohsnap
REFERENCE_NODE=snapchain
NODE_SNAPCHAIN_URL=https://snapchain-api.neynar.com
NODE_SNAPCHAIN_HEADERS={"x-api-key":"..."}
NODE_HAATZ_URL=https://haatz.quilibrium.com
NODE_HAATZ_NETWORK=hypersnap
NODE_OPENCASTER_URL=https://...
NODE_OPENCASTER_NETWORK=hypersnap
NODE_OHSNAP_URL=https://ohsnap.schmidtiest.xyz
NODE_OHSNAP_NETWORK=hypersnap
```

- A label is 1 to 24 characters: letters, digits, dashes; it must start with a letter or digit. The env key is the label upper-cased with dashes turned into underscores (`my-node` reads `NODE_MY_NODE_URL`).
- `NODE_<LABEL>_NETWORK` is required unless the label itself contains `snapchain` or `hypersnap`. Network names follow the label rules.
- `REFERENCE_NODE` defaults to the first label. It only anchors `presentOn` and the dashboard.
- `NODE_<LABEL>_HEADERS` is optional JSON. Same quoting rules as before: load the env with `node --env-file`, never by sourcing it.
- When `NODES` is unset the original `NODE_A_*` / `NODE_B_*` variables are read, with labels from `NODE_A_LABEL` / `NODE_B_LABEL` (defaults `snapchain`, `hypersnap`) and networks from `NODE_A_NETWORK` / `NODE_B_NETWORK` (defaults by slot: A is snapchain, B is hypersnap). Nothing changes for an existing two-node deployment.
- Every node must answer the same endpoints. Run `npm run check-nodes -- <fid>` after adding one; it now walks the whole list and marks the reference.

## Dashboard and API

- The dashboard title reads `snapchain (1 node) vs hypersnap (3 nodes)`. It shows one card per node (the reference is tagged), a Network split card (per network: distinct casts missing on every one of its nodes, unexplained and pending), a Scope column and the full `presentNodes` list in the diff tables, a Peer column in the stalls table, and a network-wide marker when every node of a network is stalled on a shard.
- `GET /api/summary` returns `{ nodes: string[], networks: { [network]: string[] }, reference: string, summary, info: { [label]: InfoSnapshot | null } }`. Before: `{ nodes: {a, b}, summary, info: {a, b} }`.
- `summary.byMissingNode` is `{ [label]: count }` for unexplained rows (before: `byMissingSide` with keys `a` and `b`). New: `summary.byScope = { node, network }` for unexplained rows, and `summary.networkSplit = { [network]: { unexplained, pending } }` counting distinct casts with scope `network`.
- Diff rows (`/api/diffs`) carry node labels in `presentOn` / `missingOn` instead of `"a"` / `"b"`, plus `presentNodes` (every answering node that had it), `scope` (`node` | `network` | null on old rows), and `missingNetwork`.
- Stall rows (`/api/stalls`) carry the label in `side` and gain `peer` (null for stalls recorded before the upgrade).
- The daily report schema is `snapdiff.report.v3`: `nodes` is `{ reference, labels[], networks }`, each stall has `node` and `peer`, each unexplained row has `presentNodes` and `scope`. Hashes of v2 reports stay valid for the days they covered; a v3 rebuild of an old day will hash differently because the schema string changed, so attest v3 from the day you upgrade.

Anything that consumes the API should iterate `nodes` (or `networks`) rather than assume two, compare labels, not positions, and read `scope` before blaming a node.

## Existing database

The two-node schema pinned side columns to `'a'` / `'b'` with CHECK constraints and stored those literals. On the first start of v0.5.0 the store, inside one transaction per table:

1. rebuilds `info_snapshots`, `diffs`, and `stalls` without the CHECK (rows copied, indexes recreated);
2. adds `stalls.peer`, `scans.messages_json`, and `diffs.present_json`, `diffs.scope`, `diffs.missing_network`;
3. relabels every `'a'` to the first configured node's label and every `'b'` to the second's;
4. fills `missing_network` on old rows from the configured networks. Old rows keep `scope = null` and an empty `presentNodes`; they are left out of the scope counts.

So keep the original two nodes as the first two entries of `NODES`, in the same order they had as A and B. If you reorder them, the history is attributed to the wrong node. New rows are written with labels and scope from day one, so the relabel is a no-op afterwards.

`scans.messages_a` keeps the reference node's cast count and `messages_b` the sum of the others; the per-node breakdown is in `messages_json`.

## Watching your own node

A node behind a residential connection should not be exposed directly. The pattern used for `ohsnap.schmidtiest.xyz`: the node runs at home, a small VPS terminates TLS and forwards 3381 (HTTP API) over WireGuard to it, and snapdiff talks to the VPS hostname like any other node. The home IP never appears in snapdiff's config or its page.
