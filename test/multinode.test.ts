// Multi-node: config parsing, the pairwise scan against the reference, and the legacy
// 'a'/'b' database relabel. Hubs are fakes; nothing goes online.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadNodes, loadConfig, comparedNodes } from "../src/config.js";
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

const infoFor = (side: string): InfoSnapshot => ({ side, at: 1, reachable: true, maxBlockDelay: 1, numShards: 2, numFidRegistrations: 10, shards: [], error: null });

test("loadNodes: NODES list with per-label env, reference defaults to the first, validation", () => {
  const env = {
    NODES: "snapchain, haatz,ohsnap",
    NODE_SNAPCHAIN_URL: "https://a.example/",
    NODE_SNAPCHAIN_HEADERS: '{"x-api-key":"k"}',
    NODE_HAATZ_URL: "https://b.example",
    NODE_OHSNAP_URL: "https://ohsnap.schmidtiest.xyz",
  };
  const { nodes, reference } = loadNodes(env);
  assert.deepEqual(nodes.map((n) => n.label), ["snapchain", "haatz", "ohsnap"]);
  assert.equal(nodes[0]?.url, "https://a.example", "trailing slash stripped");
  assert.deepEqual(nodes[0]?.headers, { "x-api-key": "k" });
  assert.deepEqual(nodes[2]?.headers, {});
  assert.equal(reference, "snapchain");
  assert.equal(loadNodes({ ...env, REFERENCE_NODE: "ohsnap" }).reference, "ohsnap");
  assert.throws(() => loadNodes({ ...env, REFERENCE_NODE: "nope" }), /REFERENCE_NODE/);
  assert.throws(() => loadNodes({ NODES: "one", NODE_ONE_URL: "https://x" }), /at least two/);
  assert.throws(() => loadNodes({ NODES: "a,b", NODE_A_URL: "https://x" }), /NODE_B_URL is not set/);
  assert.throws(() => loadNodes({ NODES: "a,a", NODE_A_URL: "https://x" }), /duplicate/);
  assert.throws(() => loadNodes({ NODES: "bad label,b", NODE_BAD_LABEL_URL: "https://x", NODE_B_URL: "https://y" }), /label/);
});

test("loadNodes: without NODES the original two-node variables still work", () => {
  const { nodes, reference } = loadNodes({ NODE_A_URL: "https://sc.example", NODE_B_LABEL: "haatz", NODE_B_URL: "https://hs.example" });
  assert.deepEqual(nodes.map((n) => [n.label, n.url]), [["snapchain", "https://sc.example"], ["haatz", "https://hs.example"]]);
  assert.equal(reference, "snapchain");
});

test("scan with three nodes: each compared against the reference; a failing node skips only its own pair", async () => {
  const store = new SqliteStore(":memory:");
  const cfg = {
    ...loadConfig(),
    nodes: [
      { label: "ref", url: "http://ref.test", headers: {} },
      { label: "x", url: "http://x.test", headers: {} },
      { label: "y", url: "http://y.test", headers: {} },
    ],
    reference: "ref",
    watchFids: [1, 2],
    sampleSize: 0,
    concurrency: 2,
  };
  assert.deepEqual(comparedNodes(cfg).map((n) => n.label), ["x", "y"]);
  for (const l of ["ref", "x", "y"]) await store.recordInfo(infoFor(l));
  const shared = msg(1, "0xaa");
  const onlyRef = msg(1, "0xbb");
  const onlyY = msg(2, "0xcc");
  const deps: Deps = {
    cfg,
    store,
    log: () => {},
    now: () => 5_000_000,
    hubs: {
      ref: fakeHub({ 1: [shared, onlyRef], 2: [] }),
      x: fakeHub((fid) => {
        if (fid === 2) throw new Error("x is flaky");
        return [shared];
      }),
      y: fakeHub({ 1: [shared, onlyRef], 2: [onlyY] }),
    },
  };
  const run = await scanOnce(deps);
  assert.equal(run.fidsScanned, 2, "reference answered for both FIDs");
  assert.equal(run.errors, 1, "x failed once");
  assert.deepEqual(run.messagesByNode, { ref: 2, x: 1, y: 3 });
  const rows = await store.listDiffs({});
  const key = (r: { hash: string; presentOn: string; missingOn: string }) => `${r.hash}:${r.presentOn}>${r.missingOn}`;
  assert.deepEqual(rows.map(key).sort(), ["0xbb:ref>x", "0xcc:y>ref"], "0xbb is on ref and y (no y diff), missing on x; 0xcc only on y; fid 2 on x was skipped, not diffed");
  const summary = await store.summary();
  assert.equal(summary.byCause.pending, 2);
  await store.close();
});

test("legacy database: 'a'/'b' rows are relabeled on open and the old CHECK is gone", async () => {
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
  const store = new SqliteStore(path, { a: "snapchain", b: "hypersnap" });
  assert.equal((await store.latestInfo("snapchain"))?.side, "snapchain");
  assert.equal(await store.latestInfo("a"), null);
  const d = (await store.listDiffs({}))[0]!;
  assert.deepEqual([d.presentOn, d.missingOn], ["snapchain", "hypersnap"]);
  const st = (await store.listStalls({}))[0]!;
  assert.equal(st.side, "hypersnap");
  assert.equal(st.peer, null, "pre-multi-node stalls have no peer recorded");
  // The rebuilt table accepts any label now.
  await store.insertDiff({ hash: "0x02", fid: 1, shard: null, msgTimestamp: 1, presentOn: "ohsnap", missingOn: "snapchain", messageJson: "{}", firstSeen: 2 });
  assert.equal((await store.summary()).byCause.pending, 2);
  await store.close();
});
