// Consensus view (src/consensus.ts): validators of the set in force for each shard, split
// into at tip, behind, down and not monitored, against the quorum the set needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { consensusLine, quorumOf, setFor, shardConsensus, type ConsensusNode } from "../src/consensus.js";
import type { ValidatorSet } from "../src/validators.js";

const key = (p: string) => p + "0".repeat(64 - p.length);
const OLD: ValidatorSet = { effectiveAt: 100, shardIds: [0, 1, 2], keys: ["aaaa0001", "bbbb0002", "cccc0003", "dddd0004"].map(key) };
const NEW_SHARD0: ValidatorSet = { effectiveAt: 1_000, shardIds: [0], keys: ["aaaa0001", "bbbb0002", "cccc0003", "dddd0004", "eeee0005"].map(key) };
const node = (label: string, keyPrefix: string | null, heights: Record<number, number>, reachable = true): ConsensusNode => ({
  label, name: label, keyPrefix, reachable, shards: Object.entries(heights).map(([s, h]) => ({ shardId: Number(s), maxHeight: h })),
});

test("quorum is more than two thirds", () => {
  assert.deepEqual([4, 7, 8, 11].map(quorumOf), [3, 5, 6, 8]);
});

test("the set in force is the newest entry for the shard not after the tip", () => {
  assert.equal(setFor([OLD, NEW_SHARD0], 0, 999)?.effectiveAt, 100);
  assert.equal(setFor([OLD, NEW_SHARD0], 0, 1_000)?.effectiveAt, 1_000);
  assert.equal(setFor([OLD, NEW_SHARD0], 1, 5_000)?.effectiveAt, 100, "shard 1 never adopted the new entry");
  assert.equal(setFor([OLD, NEW_SHARD0], 0, null)?.effectiveAt, 1_000, "no height: the latest entry");
  assert.equal(setFor([OLD], 0, 50), null, "before the first set");
});

test("at tip, behind, down, not monitored; state against quorum", () => {
  const nodes = [
    node("a", "aaaa0001", { 0: 500, 1: 900, 2: 700 }),
    node("b", "bbbb0002", { 0: 500, 1: 900, 2: 700 }),
    node("c", "cccc0003", { 0: 480, 1: 100, 2: 700 }), // shard 1 far behind, shard 0 within tolerance
    node("d", "dddd0004", { 0: 500, 1: 900, 2: 700 }, false), // down
    node("reader", null, { 0: 500, 1: 905, 2: 700 }), // read node, sets the shard 1 tip
  ];
  const [s0, s1, s2] = shardConsensus(nodes, [OLD]);
  assert.equal(s0!.tip, 500);
  assert.deepEqual(s0!.atTip, ["a", "b", "c"]);
  assert.deepEqual(s0!.down, ["d"]);
  assert.equal(s0!.state, "edge", "3 of 4 at tip with quorum 3");
  assert.equal(s1!.tip, 905);
  assert.deepEqual(s1!.atTip, ["a", "b"]);
  assert.deepEqual(s1!.behind, [{ name: "c", lag: 805 }]);
  assert.equal(s1!.state, "short");
  assert.equal(consensusLine(s1!), "shard 1: 2 of 4 at tip, quorum 3; behind: c (805); down: d");
  assert.equal(s2!.state, "edge");
});

test("a key with no monitored node counts as unknown, never as a vote; a new set applies per shard", () => {
  const nodes = [node("a", "aaaa0001", { 0: 1_000 }), node("b", "bbbb0002", { 0: 1_000 }), node("c", "cccc0003", { 0: 1_000 }), node("d", "dddd0004", { 0: 1_000 })];
  const [s0] = shardConsensus(nodes, [OLD, NEW_SHARD0]);
  assert.equal(s0!.setSize, 5);
  assert.equal(s0!.quorum, 4);
  assert.deepEqual(s0!.unmonitored, ["eeee0005"]);
  assert.equal(s0!.state, "edge");
  assert.match(consensusLine(s0!), /not monitored: 1$/);
});

test("no set at all reads unknown", () => {
  const [s] = shardConsensus([node("a", null, { 0: 1 })], []);
  assert.equal(s!.state, "unknown");
  assert.equal(consensusLine(s!), "shard 0: validator set not loaded");
});

test("page and /api/consensus: card renders for a network with a validators file, keyed by the peer view's key prefixes", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { buildApp } = await import("../src/server.js");
  const { SqliteStore } = await import("../src/store/sqlite.js");
  const mk = (label: string, network: string, validator = false) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [], ...(validator ? { validator: true } : {}) });
  const cfg = { ...loadConfig(), nodes: [mk("snapchain", "snapchain"), mk("hub-a", "hypersnap", true), mk("hub-b", "hypersnap", true), mk("reader", "hypersnap")], reference: "snapchain", references: { snapchain: "snapchain", hypersnap: "hub-a" } };
  const store = new SqliteStore(":memory:");
  const info = (side: string, h1: number, reachable = true) => ({ side, at: Date.now(), reachable, provider: side, note: null, maxBlockDelay: 1, numShards: 2, numFidRegistrations: 1, shards: [{ shardId: 1, maxHeight: h1, blockDelay: 1 }], error: null, version: "0.17.17" });
  for (const [l, h, r] of [["snapchain", 5, true], ["hub-a", 1_000, true], ["hub-b", 400, true], ["reader", 1_000, true]] as const) await store.recordInfo(info(l, h, r));
  const self = (keyPrefix: string) => ({ side: "x", at: 0, state: "open", error: null, fallback: false, setKnown: true, self: { peerId: null, keyPrefix, validator: true, joinsAt: null }, peers: { total: 0, validators: 0, setSize: 4 }, validators: [], missing: [] });
  const mesh = () => ({ "hub-a": self("aaaa0001"), "hub-b": self("bbbb0002") }) as never;
  const sets = (network: string) => (network === "hypersnap" ? [OLD] : null);
  const app = buildApp(cfg, store, undefined, undefined, undefined, mesh, sets);
  const api = (await (await app.request("http://x/api/consensus")).json()) as { networks: Record<string, { shardId: number; atTip: string[]; behind: { name: string; lag: number }[]; unmonitored: string[]; state: string }[]>; lines: Record<string, string[]> };
  const html = await (await app.request("http://x/")).text();
  await store.close();
  assert.equal(Object.keys(api.networks).join(), "hypersnap", "snapchain has no validators file");
  const s1 = api.networks["hypersnap"]!.find((r) => r.shardId === 1)!;
  assert.deepEqual(s1.atTip, ["hub-a"]);
  assert.deepEqual(s1.behind, [{ name: "hub-b", lag: 600 }]);
  assert.deepEqual(s1.unmonitored, ["cccc0003", "dddd0004"]);
  assert.equal(s1.state, "short");
  assert.equal(api.lines["hypersnap"]![0], "shard 1: 1 of 4 at tip, quorum 3; behind: hub-b (600); not monitored: 2");
  assert.match(html, /<h2>Consensus<\/h2>/);
  assert.match(html, /<span class="pill bad">1 of 4<\/span> <span class="muted">hub-a<\/span>/);
  assert.match(html, /hub-b \(600\)/);
  assert.equal((html.match(/<script>/g) ?? []).length, 1, "no new inline script (CSP hash)");
});
