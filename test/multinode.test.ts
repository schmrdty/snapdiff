// Multi-node: config parsing, the presence-picture scan with network scope, and the legacy
// 'a'/'b' database relabel. Hubs are fakes; nothing goes online.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadNodes, loadConfig, networks } from "../src/config.js";
import { scopeOf } from "../src/classify.js";
import type { HubClient } from "../src/hub.js";
import { scanOnce, type Deps } from "../src/loops.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { HubMessage, InfoSnapshot } from "../src/types.js";

const msg = (fid: number, hash: string): HubMessage => ({ hash, data: { type: "MESSAGE_TYPE_CAST_ADD", fid, timestamp: 100, castAddBody: { text: "x" } } });

const fakeHub = (casts: Record<number, HubMessage[]> | ((fid: number) => HubMessage[])): HubClient =>
  ({
    castsByFid: async (fid: number) => (typeof casts === "function" ? casts(fid) : (casts[fid] ?? [])),
    hasCast: async () => false,
    knowsFid: async () => true,
  }) as unknown as HubClient;

const infoFor = (side: string): InfoSnapshot => ({ side, at: 1, reachable: true, provider: null, note: null, maxBlockDelay: 1, numShards: 2, numFidRegistrations: 10, shards: [], error: null });

test("loadNodes: NODES list with per-label env, networks inferred or explicit, validation", () => {
  const env = {
    NODES: "snapchain, haatz,ohsnap",
    NODE_SNAPCHAIN_URL: "https://a.example/",
    NODE_SNAPCHAIN_HEADERS: '{"x-api-key":"k"}',
    NODE_HAATZ_URL: "https://b.example",
    NODE_HAATZ_NETWORK: "hypersnap",
    NODE_OHSNAP_URL: "https://ohsnap.schmidtiest.xyz",
    NODE_OHSNAP_NETWORK: "hypersnap",
  };
  const { nodes, reference } = loadNodes(env);
  assert.deepEqual(nodes.map((n) => [n.label, n.network]), [["snapchain", "snapchain"], ["haatz", "hypersnap"], ["ohsnap", "hypersnap"]]);
  assert.equal(nodes[0]?.url, "https://a.example", "trailing slash stripped");
  assert.deepEqual(nodes[0]?.headers, { "x-api-key": "k" });
  assert.deepEqual(nodes[2]?.headers, {});
  assert.equal(reference, "snapchain");
  assert.deepEqual(networks({ nodes }), [{ network: "snapchain", labels: ["snapchain"] }, { network: "hypersnap", labels: ["haatz", "ohsnap"] }]);
  assert.equal(loadNodes({ ...env, REFERENCE_NODE: "ohsnap" }).reference, "ohsnap");
  assert.deepEqual(loadNodes(env).references, { snapchain: "snapchain", hypersnap: "haatz" }, "per-network references default to the first-listed node");
  assert.deepEqual(loadNodes({ ...env, REFERENCE_NODE_2: "ohsnap" }).references, { snapchain: "snapchain", hypersnap: "ohsnap" });
  assert.throws(() => loadNodes({ ...env, REFERENCE_NODE_2: "snapchain" }), /same network/);
  assert.throws(() => loadNodes({ ...env, REFERENCE_NODE_2: "nope" }), /REFERENCE_NODE_2/);
  assert.equal(loadNodes({ ...env, NODE_HAATZ_NAME: " haatz.quilibrium.com " }).nodes[1]?.name, "haatz.quilibrium.com", "NAME is trimmed");
  assert.equal(loadNodes(env).nodes[1]?.name, undefined);
  assert.throws(() => loadNodes({ ...env, NODE_HAATZ_NAME: "ohsnap" }), /already the label or name/);
  assert.throws(() => loadNodes({ ...env, NODE_HAATZ_NAME: "x".repeat(41) }), /NODE_HAATZ_NAME/);
  assert.throws(() => loadNodes({ ...env, REFERENCE_NODE: "nope" }), /REFERENCE_NODE/);
  assert.throws(() => loadNodes({ NODES: "one,two", NODE_ONE_URL: "https://x", NODE_TWO_URL: "https://y" }), /NODE_ONE_NETWORK is not set/);
  assert.throws(() => loadNodes({ NODES: "one", NODE_ONE_URL: "https://x", NODE_ONE_NETWORK: "snapchain" }), /at least two/);
  assert.throws(() => loadNodes({ NODES: "a,b", NODE_A_URL: "https://x", NODE_A_NETWORK: "snapchain" }), /NODE_B_URL is not set/);
  assert.throws(() => loadNodes({ NODES: "a,a", NODE_A_URL: "https://x", NODE_A_NETWORK: "snapchain" }), /duplicate/);
  assert.throws(() => loadNodes({ NODES: "bad label,b", NODE_BAD_LABEL_URL: "https://x", NODE_BAD_LABEL_NETWORK: "snapchain", NODE_B_URL: "https://y", NODE_B_NETWORK: "hypersnap" }), /label/);
});

test("loadNodes: without NODES the original two-node variables still work, networks by slot", () => {
  const { nodes, reference } = loadNodes({ NODE_A_URL: "https://sc.example", NODE_B_LABEL: "haatz", NODE_B_URL: "https://hs.example" });
  assert.deepEqual(nodes.map((n) => [n.label, n.url, n.network]), [["snapchain", "https://sc.example", "snapchain"], ["haatz", "https://hs.example", "hypersnap"]]);
  assert.equal(reference, "snapchain");
});

test("loadNodes: fallback providers come from _URL_2, _URL_3 in order; a gap ends the list", () => {
  const { nodes } = loadNodes({
    NODE_A_URL: "https://paid.example",
    NODE_A_HEADERS: '{"x-api-key":"k"}',
    NODE_A_URL_2: "https://snap.farcaster.xyz:3381/",
    NODE_A_URL_4: "https://ignored.example",
    NODE_B_URL: "https://hs.example",
  });
  assert.deepEqual(nodes[0]?.providers, [{ url: "https://paid.example", headers: { "x-api-key": "k" } }, { url: "https://snap.farcaster.xyz:3381", headers: {} }]);
  assert.equal(nodes[0]?.url, "https://paid.example", "url stays the primary");
  assert.equal(nodes[1]?.providers.length, 1);
});

test("scopeOf: a same-network peer with the cast makes it a node problem; otherwise the network's", () => {
  const net = (l: string) => (l === "sc" ? "snapchain" : "hypersnap");
  assert.equal(scopeOf("h1", ["sc", "h2"], net), "node");
  assert.equal(scopeOf("h1", ["sc"], net), "network");
  assert.equal(scopeOf("sc", ["h1", "h2"], net), "network", "the only snapchain node lacking it is the network lacking it");
});

test("scan with three nodes on two networks: presence picture, scope per row, a failing node skips only itself", async () => {
  const store = new SqliteStore(":memory:");
  const cfg = {
    ...loadConfig(),
    nodes: [
      { label: "ref", url: "http://ref.test", network: "snapchain", headers: {}, providers: [{ url: "http://ref.test", headers: {} }] },
      { label: "x", url: "http://x.test", network: "hypersnap", headers: {}, providers: [{ url: "http://x.test", headers: {} }] },
      { label: "y", url: "http://y.test", network: "hypersnap", headers: {}, providers: [{ url: "http://y.test", headers: {} }] },
    ],
    reference: "ref",
    watchFids: [1, 2],
    sampleSize: 0,
    concurrency: 2,
  };
  for (const l of ["ref", "x", "y"]) await store.recordInfo(infoFor(l));
  const shared = msg(1, "0xaa");
  const refAndY = msg(1, "0xbb");
  const onlyY = msg(2, "0xcc");
  const onlyRef = msg(1, "0xdd");
  const deps: Deps = {
    cfg,
    store,
    log: () => {},
    now: () => 5_000_000,
    hubs: {
      ref: fakeHub({ 1: [shared, refAndY, onlyRef], 2: [] }),
      x: fakeHub((fid) => {
        if (fid === 2) throw new Error("x is flaky");
        return [shared];
      }),
      y: fakeHub({ 1: [shared, refAndY], 2: [onlyY] }),
    },
  };
  const run = await scanOnce(deps);
  assert.equal(run.fidsScanned, 2, "two nodes answered for both FIDs");
  assert.equal(run.errors, 1, "x failed once");
  assert.deepEqual(run.messagesByNode, { ref: 3, x: 1, y: 3 });
  const rows = await store.listDiffs({});
  const key = (r: { hash: string; presentNodes: string[]; missingOn: string; scope: string | null }) => `${r.hash}:${r.presentNodes.join("+")}>${r.missingOn}:${r.scope}`;
  assert.deepEqual(rows.map(key).sort(), [
    "0xbb:ref+y>x:node", // y, on x's own network, has it: x's problem
    "0xcc:y>ref:network", // the only snapchain node lacks it: the networks disagree
    "0xdd:ref>x:network", // every hypersnap node that answered lacks it
    "0xdd:ref>y:network",
  ]);
  assert.equal(rows.find((r) => r.hash === "0xcc")?.presentOn, "y");
  assert.equal(rows.find((r) => r.hash === "0xbb")?.presentOn, "ref", "presentOn prefers the reference");
  const summary = await store.summary();
  assert.equal(summary.byCause.pending, 4);
  assert.deepEqual(summary.networkSplit, { snapchain: { unexplained: 0, pending: 1 }, hypersnap: { unexplained: 0, pending: 1 } }, "0xdd is one disagreement, not two");
  await store.close();
});

test("legacy database: 'a'/'b' rows are relabeled on open, the old CHECK is gone, networks backfilled", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(mkdtempSync(join(tmpdir(), "snapdiff-legacy-")), "legacy.db");
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE info_snapshots (id INTEGER PRIMARY KEY, side TEXT NOT NULL CHECK (side IN ('a','b')), at INTEGER NOT NULL, reachable INTEGER NOT NULL, max_block_delay INTEGER, num_shards INTEGER, num_fid_registrations INTEGER, shards_json TEXT NOT NULL, error TEXT);
    CREATE TABLE diffs (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, fid INTEGER NOT NULL, shard INTEGER, msg_timestamp INTEGER NOT NULL, present_on TEXT NOT NULL CHECK (present_on IN ('a','b')), missing_on TEXT NOT NULL CHECK (missing_on IN ('a','b')), cause TEXT NOT NULL DEFAULT 'pending' CHECK (cause IN ('pending','sync_lag','relay_filtered','version_rule','unexplained')), note TEXT, message_json TEXT NOT NULL, first_seen INTEGER NOT NULL, last_checked INTEGER, attempts INTEGER NOT NULL DEFAULT 0, resolved_at INTEGER, UNIQUE (hash, missing_on));
    CREATE TABLE scans (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, fids_scanned INTEGER NOT NULL, messages_a INTEGER NOT NULL, messages_b INTEGER NOT NULL, new_diffs INTEGER NOT NULL, errors INTEGER NOT NULL);
    CREATE TABLE stalls (id INTEGER PRIMARY KEY, side TEXT NOT NULL CHECK (side IN ('a','b')), shard_id INTEGER NOT NULL, stuck_height INTEGER NOT NULL, peer_height_start INTEGER NOT NULL, peer_height_end INTEGER, max_block_delay INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, ended_at INTEGER);
    INSERT INTO info_snapshots (side, at, reachable, shards_json) VALUES ('a', 1, 1, '[]'), ('b', 1, 1, '[]');
    INSERT INTO diffs (hash, fid, msg_timestamp, present_on, missing_on, message_json, first_seen) VALUES ('0x01', 3, 1, 'a', 'b', '{}', 1);
    INSERT INTO stalls (side, shard_id, stuck_height, peer_height_start, started_at) VALUES ('b', 2, 10, 12, 1);`);
  raw.close();
  const store = new SqliteStore(path, { legacy: { a: "snapchain", b: "hypersnap" }, networks: { snapchain: "snapchain", hypersnap: "hypersnap" } });
  assert.equal((await store.latestInfo("snapchain"))?.side, "snapchain");
  assert.equal(await store.latestInfo("a"), null);
  const d = (await store.listDiffs({}))[0]!;
  assert.deepEqual([d.presentOn, d.missingOn, d.presentNodes, d.scope, d.missingNetwork], ["snapchain", "hypersnap", [], null, "hypersnap"]);
  const st = (await store.listStalls({}))[0]!;
  assert.equal(st.side, "hypersnap");
  assert.equal(st.peer, null, "pre-multi-node stalls have no peer recorded");
  assert.equal(st.scope, null, "and no scope");
  // The rebuilt table accepts any label now.
  await store.insertDiff({ hash: "0x02", fid: 1, shard: null, msgTimestamp: 1, presentOn: "ohsnap", missingOn: "snapchain", presentNodes: ["ohsnap"], scope: "network", missingNetwork: "snapchain", messageJson: "{}", firstSeen: 2 });
  assert.equal((await store.summary()).byCause.pending, 2);
  await store.close();
});
