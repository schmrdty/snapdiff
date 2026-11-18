// Mainnet and Testnet tabs on the dashboard. A network whose name contains "testnet" renders
// only on /?net=testnet; the mainnet view hides it. Tabs are links, never script, so the
// CSP hash of the single inline script (test/csp.test.ts) does not move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { InfoSnapshot } from "../src/types.js";

const node = (label: string, network: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [] });
const snap = (side: string): InfoSnapshot => ({
  side, at: Date.now(), reachable: true, provider: side, note: null, maxBlockDelay: 1, numShards: 2, numFidRegistrations: 1,
  shards: [{ shardId: 1, maxHeight: 10, blockDelay: 1 }], error: null, version: "0.17.15",
});

test("tabs: testnet nodes appear only on /?net=testnet, mainnet sections stay off that tab", async () => {
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap"), node("testnet-0", "hypersnap-testnet"), node("testnet-rn", "hypersnap-testnet")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap", "hypersnap-testnet": "testnet-0" },
  };
  const store = new SqliteStore(":memory:");
  for (const l of ["snapchain", "hypersnap", "testnet-0", "testnet-rn"]) await store.recordInfo(snap(l));
  const app = buildApp(cfg, store);
  const main = await (await app.request("http://x/")).text();
  const testnet = await (await app.request("http://x/?net=testnet")).text();
  const summary = (await (await app.request("http://x/api/summary")).json()) as { nodes: string[] };
  await store.close();

  assert.match(main, /<h1>snapdiff: snapchain \(1 node\) vs hypersnap \(1 node\)<\/h1>/, "the mainnet title counts mainnet networks only");
  assert.match(main, /<nav class="tabs"><a class="tab on" href="\/">Mainnet \(2 nodes\)<\/a><a class="tab tn" href="\/\?net=testnet">Testnet \(2 nodes\)<\/a><\/nav>/);
  assert.doesNotMatch(main, /data-net="hypersnap-testnet"/, "no testnet card on the mainnet tab");
  assert.match(main, /<div class="stats">/, "relay counts stay on mainnet");

  assert.match(testnet, /<h1>snapdiff testnet: hypersnap-testnet \(2 nodes\)<\/h1>/);
  assert.match(testnet, /<a class="tab tn on" href="\/\?net=testnet">/);
  assert.equal((testnet.match(/data-net="hypersnap-testnet"/g) ?? []).length, 2, "both testnet cards");
  assert.doesNotMatch(testnet, /data-net="hypersnap"/, "no mainnet card on the testnet tab");
  assert.doesNotMatch(testnet, /<div class="stats">|<h2>Network split<\/h2>|<h2>Unexplained<\/h2>|<h2>Pending<\/h2>/, "mainnet-only sections are absent");
  assert.match(testnet, /<h2>Shard stalls/, "stalls stay on both tabs");
  assert.match(testnet, /\.col\[data-net\*=testnet\] \.head\{background:var\(--tn\)/, "testnet cards get the neon purple");
  assert.equal((testnet.match(/<script>/g) ?? []).length, 1, "still exactly one inline script");
  assert.deepEqual(summary.nodes, ["snapchain", "hypersnap", "testnet-0", "testnet-rn"], "the API keeps every node");
});

test("tabs: no tab bar without a testnet network, and ?net=testnet falls back to the mainnet view", async () => {
  const cfg = { ...loadConfig(), nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap")], reference: "snapchain", references: { snapchain: "snapchain", hypersnap: "hypersnap" } };
  const store = new SqliteStore(":memory:");
  const app = buildApp(cfg, store);
  const main = await (await app.request("http://x/")).text();
  const forced = await (await app.request("http://x/?net=testnet")).text();
  await store.close();
  assert.doesNotMatch(main, /class="tabs"/);
  assert.match(forced, /<h1>snapdiff: snapchain \(1 node\) vs hypersnap \(1 node\)<\/h1>/);
});
