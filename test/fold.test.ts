// Collapsible cards, the Nodes card's network groups, and the cause tiles (operator, 2026-11-24).
// The page must keep exactly one inline script (its hash is pinned in deploy/Caddyfile); the
// folding lives in /static/fold.js, which the CSP allows as 'self'.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildApp, networkState } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { InfoSnapshot } from "../src/types.js";

const node = (label: string, network: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [] });
const snap = (side: string, reachable = true): InfoSnapshot => ({
  side, at: Date.now(), reachable, provider: side, note: null, maxBlockDelay: 1, numShards: 2, numFidRegistrations: 1,
  shards: reachable ? [{ shardId: 1, maxHeight: 10, blockDelay: 1 }] : [], error: reachable ? null : "timeout", version: reachable ? "0.17.20" : null,
});

test("networkState: green under 41% down, yellow at 41% or more, red only when none answer", () => {
  assert.equal(networkState(10, 0), "ok");
  assert.equal(networkState(10, 4), "ok", "40% down is still green");
  assert.equal(networkState(100, 41), "warn", "exactly 41% is yellow");
  assert.equal(networkState(7, 3), "warn", "3 of 7 (43%) is yellow");
  assert.equal(networkState(7, 6), "warn", "one node answering is yellow, not red");
  assert.equal(networkState(7, 7), "bad", "no node answering is red");
  assert.equal(networkState(1, 1), "bad");
  assert.equal(networkState(0, 0), "ok", "an empty network has nothing down");
});

async function render(downSnap: string[]) {
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), node("crackle", "snapchain"), node("hypersnap", "hypersnap"), node("ohsnap", "hypersnap"), node("imgnai", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  for (const l of ["snapchain", "crackle", "hypersnap", "ohsnap", "imgnai"]) await store.recordInfo(snap(l, !downSnap.includes(l)));
  const app = buildApp(cfg, store);
  const html = await (await app.request("http://x/")).text();
  const js = await app.request("http://x/static/fold.js");
  await store.close();
  return { html, js };
}

test("Nodes card: one foldable card holding a foldable group per network, hypersnap above snapchain, H and S badges", async () => {
  const { html } = await render(["ohsnap", "crackle", "snapchain"]);
  const index = html.slice(html.indexOf('id="index"'), html.indexOf('id="stalls"'));
  assert.match(html, /<section class="card sec fold-box" id="index" data-name="Nodes"><div class="sec-head"><h2>Nodes<\/h2><button class="fold"/);
  assert.ok(index.indexOf('id="grp-hypersnap"') < index.indexOf('id="grp-snapchain"'), "hypersnap group first");
  // hypersnap: 1 of 3 down (33%) is green; snapchain: 2 of 2 down is red.
  assert.match(index, /<div class="grp fold-box" id="grp-hypersnap" data-name="hypersnap"><div class="grp-head"><span class="nb ok" role="img" aria-label="hypersnap: 2 of 3 nodes answering\.[^"]*"[^>]*>H<\/span><h3>hypersnap /);
  assert.match(index, /<div class="grp fold-box" id="grp-snapchain" data-name="snapchain"><div class="grp-head"><span class="nb bad" [^>]*>S<\/span><h3>snapchain /);
  assert.match(index, /aria-controls="grp-hypersnap-body"/);
});

test("Nodes badge turns yellow at 41% down", async () => {
  const { html } = await render(["ohsnap", "imgnai"]);
  assert.match(html, /<span class="nb warn" [^>]*>H<\/span>/, "2 of 3 hypersnap nodes down");
  assert.match(html, /<span class="nb ok" [^>]*>S<\/span>/);
});

test("every section is a foldable card; still one inline script; fold.js is served", async () => {
  const { html, js } = await render([]);
  for (const [id, title] of [["causes", "Diffs by cause"], ["nodeinfo", "Node info"], ["index", "Nodes"], ["split", "Network split"], ["stalls", "Shard stalls"], ["unexplained", "Unexplained"], ["pending", "Pending"]] as const) {
    assert.match(html, new RegExp(`<section class="card sec fold-box" id="${id}" data-name="${title}"><div class="sec-head"><h2>${title}`), `${id} is a foldable card`);
  }
  assert.equal((html.match(/<script>/g) ?? []).length, 1, "the hash-pinned pager script is the only inline script");
  assert.match(html, /<script src="\/static\/fold\.js"><\/script>/);
  assert.equal(js.status, 200);
  assert.match(await js.text(), /snapdiff\.fold\./);
});

test("cause tiles: explanation is a hover tooltip; a chart view carries the same numbers", async () => {
  const { html } = await render([]);
  assert.match(html, /<div class="stat unexplained" tabindex="0"><div class="n">0<\/div><div class="k">unexplained<\/div>\s*<div class="help" role="tooltip">Valid under both rule sets/);
  assert.match(html, /\.stat \.help\{display:none;position:absolute/, "help hidden until hover or focus");
  assert.match(html, /\.stat:hover \.help,\.stat:focus \.help\{display:block\}/);
  assert.match(html, /<button class="vt" type="button" aria-pressed="false">Chart<\/button>/);
  assert.match(html, /<div class="cchart" role="img" aria-label="Diffs by cause: unexplained 0, pending 0, relay filtered 0, version rule 0, sync lag 0">/);
  assert.equal((html.match(/<div class="crow" /g) ?? []).length, 5);
});

test("Node cards tab: hypersnap group above snapchain, the chain filter, and every card folds on its own", async () => {
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), node("crackle", "snapchain"), node("hypersnap", "hypersnap"), node("ohsnap", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  for (const l of ["snapchain", "crackle", "hypersnap", "ohsnap"]) await store.recordInfo(snap(l, true));
  const app = buildApp(cfg, store);
  const both = await (await app.request("http://x/?view=cards")).text();
  const sc = await (await app.request("http://x/?view=cards&chain=snapchain")).text();
  const junk = await (await app.request("http://x/?view=cards&chain=nope")).text();
  await store.close();
  assert.match(both, /<h1 class="brand">Snapdiff<\/h1>/, "the title is the wordmark only; the tab says which view this is");
  assert.match(both, /<a class="tab hue c-blue on" href="\/\?view=cards">Node cards<\/a>/);
  assert.ok(both.indexOf('id="cards-hypersnap"') < both.indexOf('id="cards-snapchain"'), "hypersnap cards first");
  assert.match(both, /<nav class="jump seg" aria-label="Chain"><a class="hue c-purple" href="\/\?view=cards&amp;chain=hypersnap">Hypersnap only<\/a><a class="hue c-teal" href="\/\?view=cards&amp;chain=snapchain">Snapchain only<\/a><a class="hue c-blue on" aria-current="page" href="\/\?view=cards">Both<\/a><\/nav>/);
  assert.match(both, /<div class="col" id="node-ohsnap"[^>]*><div class="head">node<\/div><section class="card">\s*<h2>ohsnap <span class="pill ok">up<\/span><\/h2>/, "a card has no arrow of its own");
  assert.ok(!both.includes('aria-controls="node-'), "no per-card fold (operator, 2026-11-25)");
  assert.match(both, /aria-controls="cards-hypersnap-body"/, "the chain group still folds");
  assert.match(both, /<a href="\/#index">all nodes<\/a>/, "back to the index on the Mainnet tab");
  assert.ok(!sc.includes('id="cards-hypersnap"') && sc.includes('id="cards-snapchain"'), "Snapchain only");
  assert.match(sc, /<a class="hue c-teal on" aria-current="page" href="\/\?view=cards&amp;chain=snapchain">Snapchain only<\/a>/);
  assert.ok(junk.includes('id="cards-hypersnap"') && junk.includes('id="cards-snapchain"'), "an unknown chain shows both");
  for (const h of [both, sc]) {
    assert.equal((h.match(/<script>/g) ?? []).length, 1, "still one inline script");
    assert.ok(!h.includes('id="index"') && !h.includes('id="stalls"'), "the tab holds cards only");
  }
});

test("Node info wraps the node-health cards; Clients is the next card after it", async () => {
  const { html: plain } = await render([]);
  const health = [{ label: "X", network: "snapchain" as const, siteUrl: "https://x.test", siteHost: "x.test", healthUrl: null, status: "unknown" as const, httpStatus: null, latencyMs: null, checkedAt: null, note: "" }];
  const store = new SqliteStore(":memory:");
  const cfg = { ...loadConfig(), nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap")], reference: "snapchain", references: { snapchain: "snapchain", hypersnap: "hypersnap" } };
  const html = await (await buildApp(cfg as never, store, () => health as never).request("http://x/")).text();
  await store.close();
  assert.ok(!plain.includes('id="clients"'), "no Clients card without client checks");
  const infoEnd = html.indexOf('id="clients"');
  assert.ok(infoEnd > html.indexOf('id="stalls"'), "Clients comes after the last Node info card");
  assert.ok(infoEnd < html.indexOf('id="split"'), "and before the diff sections");
  const info = html.indexOf('<section class="card sec fold-box" id="nodeinfo" data-name="Node info">');
  assert.ok(info > 0, "Node info card");
  const end = html.indexOf('id="split"');
  for (const id of ["index", "stalls"]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > info && at < end, `${id} sits inside Node info`);
  }
  assert.ok(html.indexOf('id="split"') < html.indexOf('id="unexplained"'), "split stays with the diff sections");
  assert.match(html, /<nav class="jump" aria-label="Sections"><a class="hue c-orange" href="#clients">Clients<\/a>(<a class="hue c-teal" href="#consensus">Consensus<\/a>)?<a class="hue c-pink" href="#stalls">Stalls<\/a><\/nav>/, "Clients, Consensus, Stalls; no Cards link on the Mainnet tab");
  assert.ok(!html.includes('href="#index"'), "no Nodes jump link: the Nodes card sits right under the nav (operator, 2026-11-26)");
});
