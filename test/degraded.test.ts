// Degraded (Ryan, 2026-11-25): a node that answers /v1/info but is past BEHIND_BLOCK_DELAY, or
// has an open stall, reads "degraded" (yellow), not "up" and not "down". Down stays for a node
// that gives no usable answer. Degraded counts as answering in the badge, uptime, and the API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildApp, nodeState } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { InfoSnapshot } from "../src/types.js";

const node = (label: string, network: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [] });
const snap = (side: string, reachable: boolean, delay: number): InfoSnapshot => ({
  side, at: Date.now(), reachable, provider: side, note: null, maxBlockDelay: reachable ? delay : null, numShards: 2, numFidRegistrations: 1,
  shards: reachable ? [{ shardId: 1, maxHeight: 10, blockDelay: delay }] : [], error: reachable ? null : "no answer within 10s", version: "0.17.21",
});

test("nodeState: down only without an answer; behind or stalled is degraded; the line itself is up", () => {
  assert.equal(nodeState(null, 50), "no data");
  assert.equal(nodeState(snap("a", false, 0), 50), "down");
  assert.equal(nodeState(snap("a", true, 1), 50), "up");
  assert.equal(nodeState(snap("a", true, 50), 50), "up", "at the line is not past it");
  assert.equal(nodeState(snap("a", true, 45464), 50), "degraded", "catching up, 12 h behind");
  assert.equal(nodeState(snap("a", true, 1), 50, true), "degraded", "an open stall");
});

test("page and API: a catching-up node is a yellow degraded pill, counted as answering", async () => {
  const cfg = {
    ...loadConfig(),
    behindBlockDelay: 50,
    nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap"), node("astrix", "hypersnap"), node("gone", "hypersnap"), node("stuck", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  await store.recordInfo(snap("snapchain", true, 1));
  await store.recordInfo(snap("hypersnap", true, 1));
  await store.recordInfo(snap("astrix", true, 45464));
  await store.recordInfo(snap("gone", false, 0));
  await store.recordInfo(snap("stuck", true, 1));
  await store.startStall({ side: "stuck", shardId: 1, stuckHeight: 10, scope: "node", peer: "hypersnap", peerHeightStart: 12, startedAt: Date.now() });
  const app = buildApp(cfg, store);
  const cards = await (await app.request("http://x/?view=cards")).text();
  const main = await (await app.request("http://x/")).text();
  const api = (await (await app.request("http://x/api/node/astrix")).json()) as { state: string; window: { up: number; degraded: number; down: number; uptimePct: number } };
  const gone = (await (await app.request("http://x/api/node/gone")).json()) as { state: string };
  const stuck = (await (await app.request("http://x/api/node/stuck")).json()) as { state: string };
  await store.close();
  assert.match(cards, /<h2>astrix <span class="pill warn">degraded<\/span><\/h2>/, "card pill");
  assert.match(cards, /<p class="warn">12\.6h behind<\/p>/, "card says how far behind, in one line");
  assert.match(cards, /<p class="warn">Shard stalled<\/p>/, "a stall with no delay says so");
  assert.match(cards, /<td>1 <span class="pill warn">behind<\/span><\/td>/, "behind shard row");
  assert.match(cards, /<td title="45464 s">12\.6h<\/td><\/tr>/, "card delay in the index format, seconds on hover");
  assert.match(cards, /<p class="bad-text">no answer within 10s<\/p>/, "a down card shows the error only");
  assert.ok(!cards.includes("Not answering:") && !cards.includes("Other nodes still are"), "no long down sentence");
  assert.match(cards, /<h2>stuck <span class="pill warn">degraded<\/span><\/h2>/, "an open stall is degraded");
  assert.match(cards, /<h2>gone <span class="pill bad">down<\/span><\/h2>/, "no answer stays down");
  assert.match(cards, /<h2>hypersnap <span class="pill ok">up<\/span><\/h2>/);
  assert.match(main, /<span class="iname">astrix<\/span><span class="pill warn">degraded<\/span>/, "index row pill");
  assert.match(main, /<span class="sh warn" title="shard 1: height 10, block delay 45464 s, behind">/, "index shard cell");
  assert.match(main, /hypersnap: 3 of 4 nodes answering, 2 of them degraded \(behind or stalled\)\./, "badge counts degraded as answering");
  assert.equal(api.state, "degraded");
  assert.deepEqual([api.window.up, api.window.degraded, api.window.down, api.window.uptimePct], [1, 1, 0, 100], "degraded is uptime");
  assert.equal(gone.state, "down");
  assert.equal(stuck.state, "degraded");
});

test("/api/summary meta: name, role, and the page's state per node, for the Telegram bot", async () => {
  const cfg = {
    ...loadConfig(),
    behindBlockDelay: 50,
    nodes: [node("snapchain", "snapchain"), { ...node("hypersnap", "hypersnap"), name: "haatz", validator: true }, node("astrix", "hypersnap"), node("gone", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  await store.recordInfo(snap("snapchain", true, 1));
  await store.recordInfo(snap("hypersnap", true, 1));
  await store.recordInfo(snap("astrix", true, 45464));
  await store.recordInfo(snap("gone", false, 0));
  const s = (await (await buildApp(cfg, store).request("http://x/api/summary")).json()) as { meta: Record<string, { name: string; validator: boolean; reference: boolean; state: string }> };
  await store.close();
  assert.deepEqual(s.meta.hypersnap, { name: "haatz", validator: true, reference: true, state: "up" });
  assert.deepEqual(s.meta.astrix, { name: "astrix", validator: false, reference: false, state: "degraded" });
  assert.equal(s.meta.gone?.state, "down");
});
