// GET /api/node/:label: one node's latest state, a time window of samples, its stalls, and
// recent history. Built for operators who want to follow their own node (also behind the
// Telegram bot's /node). Labels are ids; names and the reference flag come from config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { InfoSnapshot } from "../src/types.js";

const node = (label: string, network: string, name?: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [], ...(name === undefined ? {} : { name }) });
const snap = (side: string, at: number, reachable: boolean, delay: number | null, provider = `${side}.example.com`): InfoSnapshot => ({
  side,
  at,
  reachable,
  provider,
  note: null,
  error: reachable ? null : "timeout",
  maxBlockDelay: delay,
  numShards: 1,
  numFidRegistrations: 10,
  shards: reachable ? [{ shardId: 0, maxHeight: 100 + at / 1000, blockDelay: delay ?? 0, numMessages: 1 }, { shardId: 1, maxHeight: 200 + at / 1000, blockDelay: 0, numMessages: 1 }] : [],
} as InfoSnapshot);

type View = {
  label: string; name: string; network: string; reference: boolean;
  latest: InfoSnapshot | null;
  window: { hours: number; fromMs: number; toMs: number; samples: number; up: number; down: number; uptimePct: number | null; worstDelay: number | null; stalls: number };
  stalls: { side: string; shardId: number; endedAt: number | null }[];
  history: { at: number; reachable: boolean; maxBlockDelay: number | null; shards: { shardId: number; maxHeight: number; blockDelay: number }[] }[];
};

test("/api/node: 404 for unknown labels, window stats, stalls for that node only, history newest first and capped", async () => {
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap", "haatz"), node("castrater", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  const now = Date.now();
  const min = 60_000;
  // castrater: 10 samples inside the last hour (2 down), 1 sample 30 h ago (outside a 24 h window).
  for (let i = 0; i < 10; i++) await store.recordInfo(snap("castrater", now - i * min, i !== 3 && i !== 7, i === 5 ? 9 : 1, "castrater"));
  await store.recordInfo(snap("castrater", now - 30 * 3_600_000, true, 50, "castrater"));
  await store.recordInfo(snap("hypersnap", now - min, true, 2));
  const stallId = await store.startStall({ side: "castrater", shardId: 1, stuckHeight: 150, scope: "node", peer: "snapchain", peerHeightStart: 160, startedAt: now - 5 * min });
  await store.startStall({ side: "hypersnap", shardId: 0, stuckHeight: 10, scope: "network", peer: "snapchain", peerHeightStart: 20, startedAt: now - 2 * min });
  const app = buildApp(cfg, store);

  const missing = await app.request("http://x/api/node/nobody");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "unknown node" });

  const r = await app.request("http://x/api/node/castrater?limit=4");
  assert.equal(r.status, 200);
  const v = (await r.json()) as View;
  assert.equal(v.label, "castrater");
  assert.equal(v.name, "castrater", "no NAME set: name is the label");
  assert.equal(v.network, "hypersnap");
  assert.equal(v.reference, false);
  assert.equal(v.latest?.at, now, "latest is the newest sample");
  assert.equal(v.latest?.provider, "castrater", "the stored provider comes back as stored (label for private nodes)");
  assert.equal(v.window.hours, 24);
  assert.equal(v.window.samples, 10, "the 30 h old sample is outside the window");
  assert.equal(v.window.up, 8);
  assert.equal(v.window.down, 2);
  assert.equal(v.window.uptimePct, 80);
  assert.equal(v.window.worstDelay, 9, "worst delay comes from samples inside the window, not the 50 outside it");
  assert.equal(v.window.stalls, 1);
  assert.equal(v.stalls.length, 1);
  assert.equal(v.stalls[0]?.side, "castrater", "the other node's stall is not included");
  assert.equal(v.history.length, 4, "limit caps history");
  assert.equal(v.history[0]?.at, now);
  assert.ok(v.history.every((h, i, a) => i === 0 || a[i - 1]!.at > h.at), "newest first");
  assert.deepEqual(Object.keys(v.history[0]!.shards[0]!), ["shardId", "maxHeight", "blockDelay"], "history shards carry only the three plotted fields");
  assert.equal(v.history[3]?.reachable, false, "the sample 3 minutes ago is the down one");

  const wide = (await (await app.request("http://x/api/node/castrater?hours=48")).json()) as View;
  assert.equal(wide.window.samples, 11, "a 48 h window includes the old sample");
  assert.equal(wide.window.worstDelay, 50);
  const clamped = (await (await app.request("http://x/api/node/castrater?hours=9999&limit=0")).json()) as View;
  assert.equal(clamped.window.hours, 168, "hours clamps to 7 days");
  assert.equal(clamped.history.length, 11, "limit 0 is not a value: the default of 60 applies, as on the other routes");

  const ref = (await (await app.request("http://x/api/node/hypersnap")).json()) as View;
  assert.equal(ref.name, "haatz", "display name from NODE_<LABEL>_NAME");
  assert.equal(ref.reference, true, "the per-network reference is flagged");
  assert.equal(ref.window.stalls, 1);

  await store.endStall(stallId, now, 170);
  const ended = (await (await app.request("http://x/api/node/castrater")).json()) as View;
  assert.equal(ended.stalls[0]?.endedAt, now, "ended stalls stay in the window");

  const empty = (await (await app.request("http://x/api/node/snapchain")).json()) as View;
  assert.equal(empty.latest, null);
  assert.equal(empty.window.uptimePct, null, "no samples: no percentage, not 0");
  assert.equal(empty.window.worstDelay, null);
  assert.deepEqual(empty.history, []);
  await store.close();
});
