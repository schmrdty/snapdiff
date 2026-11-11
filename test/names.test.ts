// Display names and per-network references: NODE_<LABEL>_NAME changes only what the page prints
// (the label stays the id in the database and the API), and REFERENCE_NODE_2 tags the other
// network's reference and is preferred for presentOn when the reference lacks the cast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { toNewDiff } from "../src/classify.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { HubMessage } from "../src/types.js";

const node = (label: string, network: string, name?: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [], ...(name === undefined ? {} : { name }) });

test("header tiles: validator replaces node, and follows reference, when NODE_<LABEL>_VALIDATOR is set", async () => {
  const cfg = {
    ...loadConfig(),
    nodes: [{ ...node("snapchain", "snapchain"), validator: true }, node("hypersnap", "hypersnap"), { ...node("castrater", "hypersnap"), validator: true }, node("ohsnap", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  const app = buildApp(cfg, store);
  const html = await (await app.request("http://x/")).text();
  const view = (await (await app.request("http://x/api/node/castrater")).json()) as { validator: boolean };
  const ro = (await (await app.request("http://x/api/node/ohsnap")).json()) as { validator: boolean };
  await store.close();
  assert.match(html, /<div class="head ref">snapchain reference validator<\/div>/, "a reference that validates says both");
  assert.match(html, /<div class="head ref">hypersnap reference<\/div>/, "a read-only reference is unchanged");
  assert.match(html, /<div class="head">hypersnap validator<\/div><section class="card">\s*<h2>castrater /, "a validator card says validator");
  assert.match(html, /<div class="head">hypersnap node<\/div><section class="card">\s*<h2>ohsnap /, "a read-only node still says node");
  assert.equal(view.validator, true);
  assert.equal(ro.validator, false);
});

test("dashboard: names replace labels on cards and in the split table; reference pills per network; API keeps ids", async () => {
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap", "haatz.quilibrium.com"), node("ohsnap", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  const app = buildApp(cfg, store);
  const html = await (await app.request("http://x/")).text();
  const summary = (await (await app.request("http://x/api/summary")).json()) as { nodes: string[]; references: Record<string, string> };
  await store.close();
  assert.match(html, /<div class="col" data-net="snapchain" data-pin><div class="head ref">snapchain reference<\/div><section class="card">\s*<h2>snapchain <span class="pill bad">no data<\/span><\/h2>/);
  assert.match(html, /<div class="col" data-net="hypersnap" data-pin><div class="head ref">hypersnap reference<\/div><section class="card">\s*<h2>haatz\.quilibrium\.com <span class="pill bad">no data<\/span><\/h2>/);
  assert.match(html, /<div class="col" data-net="hypersnap" data-extra><div class="head">hypersnap node<\/div><section class="card">\s*<h2>ohsnap <span class="pill bad">no data<\/span><\/h2>/, "plain node: header says node, title has no reference note");
  assert.doesNotMatch(html, /pill muted">[a-z ]*reference/, "no reference pills in titles");
  assert.match(html, /<td>hypersnap<\/td><td>haatz\.quilibrium\.com, ohsnap<\/td>/, "split table prints names");
  assert.doesNotMatch(html, /<h2>hypersnap /, "the label is not printed as a card title once named");
  assert.deepEqual(summary.nodes, ["snapchain", "hypersnap", "ohsnap"], "API ids unchanged");
  assert.deepEqual(summary.references, { snapchain: "snapchain", hypersnap: "hypersnap" });
});

test("presentOn: reference first, then the per-network references in order, then the first present node", () => {
  const msg = { hash: "0xAB", data: { fid: 1, timestamp: 1, type: "MESSAGE_TYPE_CAST_ADD" } } as unknown as HubMessage;
  const base = { missingOn: "sizzle", scope: "node" as const, missingNetwork: "hypersnap", reference: "snapchain", references: ["snapchain", "hypersnap"] };
  assert.equal(toNewDiff(msg, { ...base, presentNodes: ["snapchain", "ohsnap", "hypersnap"] }, 1, null).presentOn, "snapchain");
  assert.equal(toNewDiff(msg, { ...base, presentNodes: ["ohsnap", "hypersnap"] }, 1, null).presentOn, "hypersnap", "network reference beats config order");
  assert.equal(toNewDiff(msg, { ...base, presentNodes: ["ohsnap", "imgnai"] }, 1, null).presentOn, "ohsnap");
  const { references: _unused, ...noRefs } = base;
  assert.equal(toNewDiff(msg, { ...noRefs, presentNodes: ["ohsnap", "hypersnap"] }, 1, null).presentOn, "ohsnap", "without references the old rule holds");
});
