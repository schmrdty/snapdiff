# Comparing more than two nodes

snapdiff started as a two-node comparator (`a` vs `b`). From v0.5.0 it takes any number of nodes. This page covers how the comparison works with N nodes, how to configure it, what changed in the API, and what happens to an existing database.

## Model

One node is the **reference**. Every other node is compared against it, pairwise:

- A cast on the reference and not on node X: one diff row, `presentOn = reference`, `missingOn = X`.
- A cast on node X and not on the reference: one diff row, `presentOn = X`, `missingOn = reference`.
- Casts that two non-reference nodes disagree on but that the reference agrees with one of them about still show up, through the pair that disagrees with the reference. Casts missing on every node except one non-reference node show up as `presentOn = thatNode, missingOn = reference`. The only thing the pairwise model does not record directly is "X and Y differ while both agree with the reference", which cannot happen.

Each diff row is independent: a cast missing on two nodes is two rows, each rechecked and classified on its own, because the two nodes can catch up at different times. The dedupe key is `(hash, missingOn)`, so a cast missing on `ohsnap` and on `opencaster` is two rows; the same cast reported again by a later scan is not.

Scanning stops at the reference: if the reference fetch for a FID fails, that FID is skipped on this run for every pair. If a non-reference node fails for a FID, only that pair is skipped and the error is counted.

**Shard stalls** no longer need the reference. Every node's shard heights are measured against the healthiest reachable peer on that shard (lowest `blockDelay`). A node is stalled on a shard when its delay is over `BEHIND_BLOCK_DELAY` and that peer's delay is not. The stall row records which peer it was measured against. If every node is slow on a shard, nobody is stalled (network slowdown).

## Configuration

```
NODES=snapchain,haatz,opencaster,ohsnap
REFERENCE_NODE=snapchain
NODE_SNAPCHAIN_URL=https://snapchain-api.neynar.com
NODE_SNAPCHAIN_HEADERS={"x-api-key":"..."}
NODE_HAATZ_URL=https://haatz.quilibrium.com
NODE_OPENCASTER_URL=https://...
NODE_OHSNAP_URL=https://ohsnap.schmidtiest.xyz
```

- A label is 1 to 24 characters: letters, digits, dashes; it must start with a letter or digit. The env key is the label upper-cased with dashes turned into underscores (`my-node` reads `NODE_MY_NODE_URL`).
- `REFERENCE_NODE` defaults to the first label. Pick the node you trust most to be complete; today that is the Neynar Snapchain endpoint.
- `NODE_<LABEL>_HEADERS` is optional JSON. Same quoting rules as before: load the env with `node --env-file`, never by sourcing it.
- When `NODES` is unset the original `NODE_A_*` / `NODE_B_*` variables are read, with labels from `NODE_A_LABEL` / `NODE_B_LABEL` (defaults `snapchain`, `hypersnap`). Nothing changes for an existing two-node deployment.
- Every node must answer the same endpoints. Run `npm run check-nodes -- <fid>` after adding one; it now walks the whole list and marks the reference.

## Dashboard and API

- The dashboard shows one card per node (the reference is tagged), the "Missing on" line lists every node, and the stalls table has a Peer column.
- `GET /api/summary` returns `{ nodes: string[], reference: string, summary, info: { [label]: InfoSnapshot | null } }`. Before: `{ nodes: {a, b}, summary, info: {a, b} }`.
- `summary.byMissingNode` is `{ [label]: count }` for unexplained rows. Before: `summary.byMissingSide` with keys `a` and `b`.
- Diff rows (`/api/diffs`) carry node labels in `presentOn` / `missingOn` instead of `"a"` / `"b"`.
- Stall rows (`/api/stalls`) carry the label in `side` and gain `peer` (null for stalls recorded before the upgrade).
- The daily report schema is `snapdiff.report.v3`: `nodes` is `{ reference, labels[] }` and each stall has `node` and `peer`. Hashes of v2 reports stay valid for the days they covered; a v3 rebuild of an old day will hash differently because the schema string changed, so attest v3 from the day you upgrade.

Anything that consumes the API should iterate `nodes` rather than assume two, and compare labels, not positions.

## Existing database

The two-node schema pinned side columns to `'a'` / `'b'` with CHECK constraints and stored those literals. On the first start of v0.5.0 the store, inside one transaction per table:

1. rebuilds `info_snapshots`, `diffs`, and `stalls` without the CHECK (rows copied, indexes recreated);
2. adds `stalls.peer` and `scans.messages_json`;
3. relabels every `'a'` to the first configured node's label and every `'b'` to the second's.

So keep the original two nodes as the first two entries of `NODES`, in the same order they had as A and B. If you reorder them, the history is attributed to the wrong node. New rows are written with labels from day one, so the relabel is a no-op afterwards.

`scans.messages_a` keeps the reference node's cast count and `messages_b` the sum of the others; the per-node breakdown is in `messages_json`.

## Watching your own node

A node behind a residential connection should not be exposed directly. The pattern used for `ohsnap.schmidtiest.xyz`: the node runs at home, a small VPS terminates TLS and forwards 3381 (HTTP API) over WireGuard to it, and snapdiff talks to the VPS hostname like any other node. The home IP never appears in snapdiff's config or its page.
