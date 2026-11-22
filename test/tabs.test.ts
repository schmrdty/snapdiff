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

test("tabs: the stall pill and the stall rows carry this tab's networks only; a testnet-wide row never names a mainnet node", async () => {
  // Ryan's screenshot, 2026-11-19: the Testnet tab showed "3 ongoing" in red for three open
  // mainnet stalls, and its own rows read "Compared with snapchain".
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap"), node("ohsnap", "hypersnap"), node("testnet-0", "hypersnap-testnet"), node("testnet-rn", "hypersnap-testnet")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap", "hypersnap-testnet": "testnet-0" },
  };
  const store = new SqliteStore(":memory:");
  for (const n of cfg.nodes) await store.recordInfo(snap(n.label));
  const now = Date.now();
  // Three open mainnet stalls: ohsnap alone (node scope), and hypersnap-wide on two shards,
  // measured against snapchain (both mainnets, both on the Mainnet tab).
  await store.startStall({ side: "ohsnap", shardId: 1, stuckHeight: 100, scope: "node", peer: "hypersnap", peerHeightStart: 110, startedAt: now - 600_000 });
  await store.startStall({ side: "hypersnap", shardId: 2, stuckHeight: 100, scope: "network", peer: "snapchain", peerHeightStart: 900, startedAt: now - 300_000 });
  await store.startStall({ side: "ohsnap", shardId: 2, stuckHeight: 100, scope: "network", peer: "snapchain", peerHeightStart: 900, startedAt: now - 300_000 });
  // One ended testnet-wide stall, measured against snapchain (the only healthy clock: src/stall.ts).
  const t = await store.startStall({ side: "testnet-0", shardId: 0, stuckHeight: 4_499, scope: "network", peer: "snapchain", peerHeightStart: 50_000, startedAt: now - 48 * 3_600_000 });
  await store.endStall(t, now - 47 * 3_600_000, 51_000);
  const app = buildApp(cfg, store);
  const main = await (await app.request("http://x/")).text();
  const testnet = await (await app.request("http://x/?net=testnet")).text();
  await store.close();
  const section = (html: string) => html.slice(html.indexOf("<h2>Shard stalls"), html.indexOf("</section>", html.indexOf("<h2>Shard stalls")));

  assert.match(main, /<h2>Shard stalls <span class="pill bad">3 ongoing<\/span>/, "the mainnet pill counts the three mainnet stalls");
  const row = (html: string, start: string) => html.slice(html.indexOf(start), html.indexOf("</div>", html.indexOf(start)));
  assert.match(row(section(main), "<span>hypersnap (network-wide)</span><span>2</span>"), /<span>snapchain<\/span><span>900<\/span>/, "a hypersnap-wide row still names snapchain on the Mainnet tab");
  assert.doesNotMatch(section(main), /testnet-0/, "the testnet row stays off the Mainnet tab");

  assert.match(testnet, /<h2>Shard stalls<\/h2>|<h2>Shard stalls<span/, "no ongoing pill: none of this tab's nodes is stalled");
  assert.doesNotMatch(testnet, /ongoing/, "no open mainnet stall leaks into the Testnet tab");
  assert.doesNotMatch(section(testnet), /snapchain|ohsnap|50,000|51,000/, "the testnet row names no mainnet node and shows no mainnet height");
  assert.match(row(section(testnet), "<span>testnet-0 (network-wide)</span><span>0</span>"), /<span><span class="muted" title="Every hypersnap-testnet node was stopped on this shard[^"]*">whole network<\/span><\/span><span><span class="muted">n\/a<\/span><\/span>/);
});

test("node index: every node of the view is listed once and links to a card that is on the page; no pager", async () => {
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), { ...node("hypersnap", "hypersnap"), validator: true }, { ...node("val.two", "hypersnap"), validator: true, name: "second" }, node("reader", "hypersnap"), node("testnet-0", "hypersnap-testnet")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap", "hypersnap-testnet": "testnet-0" },
  };
  const store = new SqliteStore(":memory:");
  for (const l of ["snapchain", "hypersnap", "val.two", "reader", "testnet-0"]) await store.recordInfo(snap(l));
  const html = await (await buildApp(cfg, store).request("http://x/")).text();
  await store.close();
  const index = html.slice(html.indexOf('id="index"'), html.indexOf('id="nodes"'));
  const links = [...index.matchAll(/<a class="irow" href="#node-([^"]+)"/g)].map((m) => decodeURIComponent(m[1]!));
  assert.deepEqual(links, ["snapchain", "hypersnap", "val.two", "reader"], "reference, then validators, then read nodes; testnet nodes stay on their tab");
  for (const l of links) assert.ok(html.includes(`<div class="col" id="node-${l}"`), `card for ${l} is on the page`);
  assert.match(index, /hypersnap <span class="muted">2 validators, 1 read node<\/span>/);
  assert.match(index, /<span class="iname">second<\/span>/, "the display name, not the label");
  assert.ok(!html.includes('id="pager"'), "no pager element, so the inline script does nothing and no card is hidden");
  assert.equal((html.match(/<script>/g) ?? []).length, 1, "the inline script is unchanged (its hash is pinned in the Caddyfile)");
  assert.ok(html.includes('href="#stalls"') && html.includes('id="stalls"'), "jump link to the stalls card");
  assert.ok(!html.includes('href="#consensus"') && !html.includes('href="#clients"'), "no jump link to a card this deployment does not render");
});
