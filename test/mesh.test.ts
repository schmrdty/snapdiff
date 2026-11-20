// Peer view from /v1/currentPeers, classified against the validators file. Fixtures are real
// responses from 2026-11-20 with addresses replaced; the sample validators file is synthetic
// except for one real public key used to check the peer-id derivation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig, meshNodes, parseMeshNetworks, parseValidatorSetUrls } from "../src/config.js";
import type { HubClient } from "../src/hub.js";
import { MESH_MAX_PEERS, MeshMonitor, meshLine, summarizePeers } from "../src/mesh.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { InfoSnapshot } from "../src/types.js";
import { keyFromPeerId, parseValidatorSets, resolveSets, ValidatorSetMonitor } from "../src/validators.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const sampleToml = readFileSync(new URL("./fixtures/validators-sample.toml", import.meta.url), "utf8");
const OHSNAP_PEER = "12D3KooWRiEqbykRZgkZiWYXmf8iiGi4aMFeovgRg88EgtFGoydh";
const OHSNAP_KEY = "ec2937c83922ff75785ab2d552f177f83fc72cf6aaf8aee7e330e6d4c338bd50";
const HOMIE_PEER = "12D3KooW9uPjmgKNasKiu6j8D4h5pRCLNwLDJxovaAccnz3iRFvS";
const HOMIE_KEY = "0149adb8c10672b17a86fb0b9247433d12b7e22c1b888499d3be5cde5171c463";

test("keyFromPeerId: the ed25519 key behind a 12D3KooW peer id, two public vectors, garbage rejected", () => {
  assert.equal(keyFromPeerId(OHSNAP_PEER), OHSNAP_KEY);
  assert.equal(keyFromPeerId(HOMIE_PEER), HOMIE_KEY);
  assert.equal(keyFromPeerId("12D3KooW" + "0".repeat(44)), null, "0 is not a base58 digit");
  assert.equal(keyFromPeerId("QmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N"), null, "not an ed25519 identity id");
  assert.equal(keyFromPeerId(""), null);
});

test("parseValidatorSets: blocks, underscores, shard ids, comments dropped including hex inside them", () => {
  const sets = parseValidatorSets(sampleToml);
  assert.deepEqual(sets.map((s) => [s.effectiveAt, s.shardIds, s.keys.map((k) => k.slice(0, 8))]), [
    [0, [0, 1, 2], ["aaaaaaaa", "bbbbbbbb"]],
    [1000, [0], ["aaaaaaaa", "ec2937c8"]],
    [5000, [1, 2], ["aaaaaaaa", "ec2937c8"]],
  ]);
  assert.ok(!JSON.stringify(sets).includes("cccccccc"), "a key that only appears in a comment is not a validator");
  assert.deepEqual(parseValidatorSets("nothing here"), []);
});

test("resolveSets: current and next per shard follow the heights; no height means latest", () => {
  const sets = parseValidatorSets(sampleToml);
  const early = resolveSets(sets, () => 10);
  assert.deepEqual([...early.current].sort(), ["aaaaaaaa", "bbbbbbbb"]);
  assert.deepEqual(early.next.get("ec2937c8"), { effectiveAt: 1000, shardId: 0 }, "joins at the earliest future height");
  assert.equal(early.size, 2);
  const mid = resolveSets(sets, (shard) => (shard === 0 ? 2000 : 10));
  assert.ok(mid.current.has("ec2937c8"), "current on shard 0 counts as current");
  assert.ok(mid.current.has("bbbbbbbb"), "still current on shards 1 and 2");
  assert.equal(mid.next.has("ec2937c8"), false, "a current key is never also next");
  const late = resolveSets(sets, () => null);
  assert.deepEqual([...late.current].sort(), ["aaaaaaaa", "ec2937c8"]);
  assert.equal(late.next.size, 0);
});

test("summarizePeers: a mainnet read node against the real file shape: validators among peers, the missing ones, self role", () => {
  const sets = resolveSets(parseValidatorSets(sampleToml), () => 10);
  // Pretend the current set is aaaaaaaa + bbbbbbbb and the peers hold ohsnap's key: nobody current is connected.
  const m = summarizePeers("ohsnap", 200, fixture("peers-ohsnap-2026-11-20.json"), 1, false, { selfPeerId: OHSNAP_PEER, sets });
  assert.equal(m.state, "open");
  assert.equal(m.peers.total, 20);
  assert.equal(m.peers.validators, 0);
  assert.deepEqual(m.missing, ["aaaaaaaa", "bbbbbbbb"]);
  assert.equal(m.self?.validator, false);
  assert.equal(m.self?.joinsAt, 1000, "ohsnap's own key is in the next set");
  assert.equal(meshLine(m), "read node, 0 of 2 validators connected");
  // Now a set that contains two of the fixture's peers: homie and the imgnai host.
  const custom = { current: new Set([HOMIE_KEY.slice(0, 8), "7882148c", "ffffffff"]), next: new Map([["aaaaaaaa", { effectiveAt: 99, shardId: 0 }]]), size: 3 };
  const n = summarizePeers("ohsnap", 200, fixture("peers-ohsnap-2026-11-20.json"), 1, false, { selfPeerId: OHSNAP_PEER, sets: custom });
  assert.deepEqual(n.validators.map((v) => [v.keyPrefix, v.validator, v.joinsAt]), [["0149adb8", true, null], ["7882148c", true, null]]);
  assert.deepEqual(n.missing, ["ffffffff"]);
  assert.equal(meshLine(n), "read node, 2 of 3 validators connected");
  assert.ok(!JSON.stringify(n).includes("198.51.100"), "no address from the response is kept");
});

test("summarizePeers: testnet validator, self excluded from missing and from the denominator; no set loaded; states", () => {
  const hst0Self = "12D3KooWAKzRZCQkaeZuC7vMATpfbJN27xEXMFhYZsW8h7eMBKKj";
  const hst1 = "12D3KooWKgXEoET55p4ZPwNxANunvCgd1hNzSn8QpEoLvHkvmCwC";
  const k = (id: string) => keyFromPeerId(id)!.slice(0, 8);
  const sets = { current: new Set([k(hst0Self), k(hst1)]), next: new Map(), size: 2 };
  const m = summarizePeers("testnet-0", 200, fixture("peers-hst0-2026-11-20.json"), 1, false, { selfPeerId: hst0Self, sets });
  assert.equal(m.self?.validator, true);
  assert.deepEqual(m.missing, []);
  assert.equal(meshLine(m), "validator, 1 of 1 validators connected");
  const noSet = summarizePeers("testnet-0", 200, fixture("peers-hst0-2026-11-20.json"), 1, false, { selfPeerId: hst0Self, sets: null });
  assert.equal(noSet.setKnown, false);
  assert.equal(meshLine(noSet), "role unknown, 2 peers, validator set not loaded".replace("role unknown", "read node"));
  assert.equal(meshLine(summarizePeers("x", 200, fixture("peers-hst0-2026-11-20.json"), 1, false, { selfPeerId: null, sets: null })), "role unknown, 2 peers, validator set not loaded");
  assert.equal(summarizePeers("x", 401, null, 1, false, { selfPeerId: null, sets }).state, "closed");
  assert.equal(summarizePeers("x", 404, null, 1, false, { selfPeerId: null, sets }).state, "absent");
  assert.equal(summarizePeers("x", 0, null, 1, false, { selfPeerId: null, sets }).error, "node did not answer");
  assert.equal(summarizePeers("x", 200, { self: {} }, 1, false, { selfPeerId: null, sets }).state, "unreachable", "a mesh-shaped body is not a peers body");
  assert.equal(summarizePeers("x", 500, { peers: [] }, 1, false, { selfPeerId: null, sets }).error, "node answered with an error");
});

test("summarizePeers safety: hostile body, duplicates, caps, prototype keys", () => {
  const good = (i: number) => ({ peer_id: OHSNAP_PEER.slice(0, 8) + String(i).padStart(44, "z").replace(/0/g, "y") });
  const body = { peers: [{ peer_id: "<script>" }, { peer_id: OHSNAP_PEER }, { peer_id: OHSNAP_PEER }, null, 7, { peer_id: HOMIE_PEER, observed_address: "x", contact_info: { gossip_address: "y" } }, ...Array.from({ length: 6000 }, (_, i) => good(i))], __proto__: { hack: 1 } };
  const sets = { current: new Set([OHSNAP_KEY.slice(0, 8), HOMIE_KEY.slice(0, 8)]), next: new Map(), size: 2 };
  const m = summarizePeers("x", 200, body, 1, false, { selfPeerId: null, sets });
  assert.ok(m.peers.total <= 5000 + 2, "scan is capped");
  assert.equal(m.validators.length, 2, "ohsnap once (deduplicated) and homie");
  assert.ok(m.validators.length <= MESH_MAX_PEERS);
  const text = JSON.stringify(m);
  assert.ok(!text.includes("<script>") && !text.includes("observed_address") && !text.includes("gossip_address"));
});

test("ValidatorSetMonitor: keeps the last good copy through a failed fetch, logs a changed set", async () => {
  const logs: string[] = [];
  let body = sampleToml;
  let status = 200;
  const fetchFn = (async () => new Response(body, { status })) as unknown as typeof fetch;
  const mon = new ValidatorSetMonitor({ hypersnap: "https://example.test/validators.toml" }, (l) => logs.push(l), fetchFn, () => 5);
  await mon.runAll();
  assert.equal(mon.sets("hypersnap")?.length, 3);
  assert.match(logs[0] ?? "", /hypersnap: 3 sets, latest effective at 5000 with 2 keys/);
  status = 503;
  await mon.runAll();
  assert.equal(mon.sets("hypersnap")?.length, 3, "503 keeps the copy");
  assert.match(logs.at(-1) ?? "", /fetch failed \(HTTP 503\)/);
  status = 200;
  body = sampleToml + '\n[[consensus.validator_sets]]\neffective_at = 9_000\nshard_ids = [ 0 ]\nvalidator_public_keys = [ "dddddddd00000000000000000000000000000000000000000000000000000004" ]\n';
  await mon.runAll();
  assert.equal(mon.sets("hypersnap")?.length, 4);
  assert.match(logs.at(-1) ?? "", /4 sets, latest effective at 9000 with 1 keys/);
  assert.equal(mon.sets("other"), null);
});

test("MeshMonitor: reads peers through the hub, uses the hub's own peer id, logs on change only", async () => {
  const logs: string[] = [];
  let status = 200;
  const hub = { peerId: OHSNAP_PEER, lastShards: [], peers: async () => ({ status, body: fixture("peers-ohsnap-2026-11-20.json"), fallback: false }) } as unknown as HubClient;
  const sets = { current: new Set([HOMIE_KEY.slice(0, 8), "ffffffff"]), next: new Map(), size: 2 };
  const mon = new MeshMonitor({ ohsnap: hub }, { resolve: () => sets }, (l) => logs.push(l), () => 7);
  await mon.runAll();
  await mon.runAll();
  assert.equal(logs.length, 1);
  assert.equal(logs[0], "[peers] ohsnap: read node, 1 of 2 validators connected (missing ffffffff)");
  status = 401;
  await mon.runAll();
  assert.equal(logs.at(-1), "[peers] ohsnap: closed");
  const snap = mon.snapshot();
  snap["ohsnap"]!.missing.push("tamper");
  assert.equal(mon.snapshot()["ohsnap"]!.missing.includes("tamper"), false, "snapshot is a copy");
});

test("config: MESH_NETWORKS gating and VALIDATOR_SET_URLS parsing", () => {
  assert.deepEqual(parseMeshNetworks(" Mainnet, TESTNET "), ["mainnet", "testnet"]);
  assert.deepEqual(parseMeshNetworks("off"), []);
  assert.throws(() => parseMeshNetworks("hypersnap"), /MESH_NETWORKS/);
  const nodes = [{ label: "ohsnap", url: "http://a", network: "hypersnap", headers: {}, providers: [] }, { label: "testnet-0", url: "http://b", network: "hypersnap-testnet", headers: {}, providers: [] }];
  const urls = { hypersnap: "https://a.test/v.toml", "hypersnap-testnet": "https://b.test/t.toml" };
  assert.deepEqual(meshNodes({ nodes, meshNetworks: ["testnet"], validatorSetUrls: urls }).map((n) => n.label), ["testnet-0"]);
  assert.deepEqual(meshNodes({ nodes, meshNetworks: ["mainnet", "testnet"], validatorSetUrls: urls }).map((n) => n.label), ["ohsnap", "testnet-0"]);
  assert.deepEqual(meshNodes({ nodes: [...nodes, { label: "snapchain", url: "http://c", network: "snapchain", headers: {}, providers: [] }], meshNetworks: ["mainnet", "testnet"], validatorSetUrls: urls }).map((n) => n.label), ["ohsnap", "testnet-0"], "a network without a validators file is not polled");
  assert.deepEqual(parseValidatorSetUrls(""), {});
  assert.deepEqual(parseValidatorSetUrls("off"), {});
  assert.deepEqual(parseValidatorSetUrls("hypersnap=https://a.test/v.toml, hypersnap-testnet=https://b.test/t.toml"), { hypersnap: "https://a.test/v.toml", "hypersnap-testnet": "https://b.test/t.toml" });
  assert.throws(() => parseValidatorSetUrls("hypersnap=http://a.test/v.toml"), /https/);
  assert.throws(() => parseValidatorSetUrls("nourl"), /network=https/);
  assert.ok(loadConfig().validatorSetUrls["hypersnap"]?.startsWith("https://raw.githubusercontent.com/"), "mainnet default points at the upstream file");
});

test("page and API: names from each node's own peer id, missing validators named when known, mainnet untouched when only testnet is enabled, a prototype label renders", async () => {
  const node = (label: string, network: string, name?: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [], ...(name ? { name } : {}), validator: true });
  const cfg = { ...loadConfig(), nodes: [node("constructor", "hypersnap"), node("t0", "hypersnap-testnet"), node("t1", "hypersnap-testnet", "testnet-1")], reference: "constructor", references: { hypersnap: "constructor", "hypersnap-testnet": "t0" }, meshNetworks: ["testnet"] as const };
  const snap = (side: string): InfoSnapshot => ({ side, at: Date.now(), reachable: true, provider: side, note: null, maxBlockDelay: 1, numShards: 2, numFidRegistrations: 1, shards: [{ shardId: 0, maxHeight: 10, blockDelay: 1 }], error: null, version: "0.17.16" });
  const store = new SqliteStore(":memory:");
  for (const n of cfg.nodes) await store.recordInfo(snap(n.label));
  const t0Self = "12D3KooWAKzRZCQkaeZuC7vMATpfbJN27xEXMFhYZsW8h7eMBKKj";
  const t1Self = "12D3KooWKgXEoET55p4ZPwNxANunvCgd1hNzSn8QpEoLvHkvmCwC";
  const k = (id: string) => keyFromPeerId(id)!.slice(0, 8);
  const sets = { current: new Set([k(t0Self), k(t1Self), "ffffffff"]), next: new Map([[OHSNAP_KEY.slice(0, 8), { effectiveAt: 50_971_518, shardId: 0 }]]), size: 3 };
  const t0 = summarizePeers("t0", 200, fixture("peers-hst0-2026-11-20.json"), 1, false, { selfPeerId: t0Self, sets });
  // t1's own view is unreachable this round, but its peer id is known from info, so t0's row still names it.
  const t1 = summarizePeers("t1", 0, null, 1, false, { selfPeerId: t1Self, sets });
  const meshSnap = { t0, t1 };
  const app = buildApp(cfg as never, store, undefined, undefined, undefined, () => meshSnap);
  const testnet = await (await app.request("http://x/?net=testnet")).text();
  const main = await (await app.request("http://x/")).text();
  const api = (await (await app.request("http://x/api/mesh")).json()) as { source: string; names: Record<string, string>; mesh: Record<string, { missing: string[] }>; validatorSets: string[] };
  const nodeApi = (await (await app.request("http://x/api/node/t0")).json()) as { mesh: { state: string } | null };
  const noMesh = await buildApp(cfg as never, store).request("http://x/");
  await store.close();
  assert.match(testnet, /peers: validator, 1 of 2 validators connected/);
  assert.match(testnet, /validators: <span class="peer" title="testnet-1, peer 12D3KooWKgXE[^"]*">testnet-1<\/span>/, "the row shows the node name");
  assert.doesNotMatch(testnet, /missing:/, "missing validators are API and log only");
  assert.match(testnet, /peers: unreachable/, "t1's own card says unreachable");
  assert.doesNotMatch(main, /peers: /, "mainnet cards carry no peer line while only testnet is enabled");
  assert.equal(noMesh.status, 200, "a label named constructor renders without a peer snapshot");
  assert.equal(api.source, "currentPeers");
  assert.equal(api.names[t1Self], "testnet-1");
  assert.deepEqual(api.mesh["t0"]?.missing, ["ffffffff"]);
  assert.deepEqual(api.validatorSets, ["hypersnap"]);
  assert.equal(nodeApi.mesh?.state, "open");
});
