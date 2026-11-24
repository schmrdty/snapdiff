// Collapsible cards, the Nodes card's network groups, and the cause tiles (Ryan, 2026-11-24).
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
  const index = html.slice(html.indexOf('id="index"'), html.indexOf('id="nodes"'));
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
  for (const [id, title] of [["causes", "Diffs by cause"], ["index", "Nodes"], ["nodes", "Cards"], ["split", "Network split"], ["stalls", "Shard stalls"], ["unexplained", "Unexplained"], ["pending", "Pending"]] as const) {
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
