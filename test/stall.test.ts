import { test } from "node:test";
import assert from "node:assert/strict";
import { shardForFid } from "../src/shard.js";
import { detectStalls, shardBehind } from "../src/stall.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { updateStalls, recheckOnce, type Deps } from "../src/loops.js";
import { loadConfig } from "../src/config.js";
import type { HubClient } from "../src/hub.js";
import type { InfoSnapshot, Side } from "../src/types.js";

const info = (side: Side, delays: Record<number, number>, heights: Record<number, number> = {}): InfoSnapshot => ({
  side,
  at: 0,
  reachable: true,
  maxBlockDelay: Math.max(...Object.values(delays)),
  numShards: 2,
  numFidRegistrations: 100,
  shards: Object.entries(delays).map(([id, d]) => ({ shardId: Number(id), maxHeight: heights[Number(id)] ?? 1000, blockDelay: d })),
  error: null,
});

test("shardForFid: exact algorithm, stable vectors, range", () => {
  // Vectors: sha256(fid as u32 big-endian), first 4 bytes big-endian, % 2, + 1.
  // 216202 and 777527 were confirmed against haatz.quilibrium.com /v1/events (both on shard 1).
  assert.equal(shardForFid(1, 2), 1);
  assert.equal(shardForFid(2, 2), 2);
  assert.equal(shardForFid(3, 2), 1);
  assert.equal(shardForFid(216202, 2), 1);
  assert.equal(shardForFid(777527, 2), 1);
  assert.equal(shardForFid(1108653, 2), 2);
  assert.throws(() => shardForFid(2 ** 32, 2), "fid is u32 on disk");
  for (let fid = 1; fid < 2000; fid++) {
    const s = shardForFid(fid, 3);
    assert.ok(s >= 1 && s <= 3);
  }
  assert.throws(() => shardForFid(-1, 2));
  assert.throws(() => shardForFid(1, 0));
});

test("detectStalls: one side stuck on one shard, other healthy", () => {
  const a = info("a", { 0: 3, 1: 4, 2: 5 }, { 2: 5000 });
  const b = info("b", { 0: 3, 1: 4, 2: 400 }, { 2: 4100 });
  const s = detectStalls(a, b, 50);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0], { side: "b", shardId: 2, stuckHeight: 4100, blockDelay: 400, peerHeight: 5000, peerBlockDelay: 5 });
});

test("detectStalls: both slow is a network slowdown, not a stall; unreachable is unknown", () => {
  assert.equal(detectStalls(info("a", { 1: 300 }), info("b", { 1: 310 }), 50).length, 0);
  assert.equal(detectStalls(info("a", { 1: 3 }), null, 50).length, 0);
  const down: InfoSnapshot = { ...info("b", { 1: 3 }), reachable: false };
  assert.equal(detectStalls(info("a", { 1: 3 }), down, 50).length, 0);
});

test("shardBehind: per-shard gate falls back to whole node without a tag", () => {
  const b = info("b", { 0: 3, 1: 4, 2: 400 });
  assert.equal(shardBehind(b, 2, 50), true);
  assert.equal(shardBehind(b, 1, 50), false, "shard 1 is fine even though shard 2 is stalled");
  assert.equal(shardBehind(b, null, 50), true, "no tag: whole-node check (worst shard)");
  assert.equal(shardBehind(null, 1, 50), true);
});

test("stall lifecycle: start, touch, end; recheck pauses only the stalled shard", async () => {
  const store = new SqliteStore(":memory:");
  const cfg = { ...loadConfig(), behindBlockDelay: 50, recheckAfterMs: 0, recheckWindowMs: 1e12, unexplainedAfterMs: 0 };
  const logs: string[] = [];
  let t = 1_000_000;
  const hub = { hasCast: async () => false, knowsFid: async () => true } as unknown as HubClient;
  const deps: Deps = {
    cfg,
    store,
    log: (m) => logs.push(m),
    now: () => t,
    hubs: { a: hub, b: hub },
  };

  // One diff on each shard, both missing on b.
  await store.insertDiff({ hash: "0x01", fid: 3, shard: 1, msgTimestamp: 1, presentOn: "a", missingOn: "b", messageJson: JSON.stringify({ hash: "0x01", data: { type: "x", fid: 3, timestamp: 1, castAddBody: { text: "hi" } } }), firstSeen: t - 10 });
  await store.insertDiff({ hash: "0x02", fid: 1, shard: 2, msgTimestamp: 1, presentOn: "a", missingOn: "b", messageJson: JSON.stringify({ hash: "0x02", data: { type: "x", fid: 1, timestamp: 1, castAddBody: { text: "hi" } } }), firstSeen: t - 10 });

  // b stalls on shard 2.
  const a1 = info("a", { 0: 3, 1: 4, 2: 5 }, { 2: 5000 });
  const b1 = info("b", { 0: 3, 1: 4, 2: 120 }, { 2: 4900 });
  for (const s of [a1, b1]) await store.recordInfo(s);
  await updateStalls(deps, a1, b1);
  let open = await store.openStalls();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.maxBlockDelay, 120);
  assert.match(logs.at(-1) ?? "", /START .* shard 2 stuck at height 4900/);

  // Recheck: shard-1 diff gets judged (unexplained, since age > 0 and not found); shard-2 diff stays pending.
  await recheckOnce(deps);
  const rows = await store.listDiffs({});
  assert.equal(rows.find((r) => r.hash === "0x01")!.cause, "unexplained");
  assert.equal(rows.find((r) => r.hash === "0x02")!.cause, "pending");

  // Still stalled next tick: same record, worse delay.
  t += 60_000;
  const b2 = info("b", { 0: 3, 1: 4, 2: 180 }, { 2: 4900 });
  await updateStalls(deps, a1, b2);
  open = await store.openStalls();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.maxBlockDelay, 180);

  // Recovered.
  t += 60_000;
  const b3 = info("b", { 0: 3, 1: 4, 2: 6 }, { 2: 5120 });
  await updateStalls(deps, a1, b3);
  assert.equal((await store.openStalls()).length, 0);
  const done = (await store.listStalls({}))[0]!;
  assert.equal(done.endedAt, t);
  assert.equal(done.peerHeightEnd, 5000);
  assert.match(logs.at(-1) ?? "", /END .* shard 2 after 2m/);
  assert.equal((await store.summary()).totalStalls, 1);
  await store.close();
});
