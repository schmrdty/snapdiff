// Version drift: the newest version among a network's reachable nodes is "latest"; a node
// below it reads "behind" on its card, in /api/node and /api/summary. Unreachable nodes and
// nodes that report no version never set the bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { compareVersions, latestVersions, versionView } from "../src/versions.js";
import type { InfoSnapshot } from "../src/types.js";

const node = (label: string, network: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [] });
const snap = (side: string, reachable: boolean, version: string | null): InfoSnapshot => ({
  side, at: Date.now(), reachable, provider: side, note: null, maxBlockDelay: reachable ? 1 : null, numShards: 2, numFidRegistrations: 1,
  shards: reachable ? [{ shardId: 1, maxHeight: 10, blockDelay: 1 }] : [], error: reachable ? null : "timeout", version,
});

test("compareVersions: numeric dot parts, missing parts are zero, text parts compare as text", () => {
  assert.equal(compareVersions("0.17.5", "0.17.4"), 1);
  assert.equal(compareVersions("0.17.4", "0.17.5"), -1);
  assert.equal(compareVersions("0.17.5", "0.17.5"), 0);
  assert.equal(compareVersions("0.9.0", "0.17.0"), -1, "not a string compare");
  assert.equal(compareVersions("0.17", "0.17.0"), 0);
  assert.equal(compareVersions("1.0.0-rc1", "1.0.0"), 1, "a suffix counts as an extra part");
});

test("latestVersions and versionView: per network, reachable nodes only, behind when older", () => {
  const infos = { a: snap("a", true, "0.17.4"), b: snap("b", true, "0.17.5"), c: snap("c", false, "0.18.0"), d: snap("d", true, null), e: null };
  const latest = latestVersions({ hypersnap: ["a", "b", "c"], snapchain: ["d", "e"] }, infos);
  assert.deepEqual(latest, { hypersnap: "0.17.5", snapchain: null }, "the down node's 0.18.0 does not count; a network with no versions is null");
  assert.deepEqual(versionView("0.17.4", "0.17.5"), { current: "0.17.4", latest: "0.17.5", behind: true });
  assert.deepEqual(versionView("0.17.5", "0.17.5"), { current: "0.17.5", latest: "0.17.5", behind: false });
  assert.deepEqual(versionView(null, "0.17.5"), { current: null, latest: "0.17.5", behind: false }, "unknown is never behind");
  assert.deepEqual(versionView(undefined, null), { current: null, latest: null, behind: false });
});

test("page and API: the card shows the version and a behind pill; /api/node and /api/summary carry the same", async () => {
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap"), node("ohsnap", "hypersnap"), node("quiet", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  await store.recordInfo(snap("snapchain", true, "0.12.0"));
  await store.recordInfo(snap("hypersnap", true, "0.17.5"));
  await store.recordInfo(snap("ohsnap", true, "0.17.4"));
  await store.recordInfo(snap("quiet", true, null));
  const app = buildApp(cfg, store);
  const html = await (await app.request("http://x/")).text();
  const behind = (await (await app.request("http://x/api/node/ohsnap")).json()) as { version: unknown };
  const current = (await (await app.request("http://x/api/node/hypersnap")).json()) as { version: unknown };
  const none = (await (await app.request("http://x/api/node/quiet")).json()) as { version: unknown };
  const summary = (await (await app.request("http://x/api/summary")).json()) as { versions: unknown; info: Record<string, { version?: string | null }> };
  await store.close();
  assert.match(html, /<h2>ohsnap [\s\S]*?<p class="muted">v0\.17\.4 <span class="pill bad" title="newest on this network: 0\.17\.5">behind 0\.17\.5<\/span><\/p>/, "behind pill on the lagging card");
  assert.match(html, /<h2>hypersnap [\s\S]*?<p class="muted">v0\.17\.5<\/p>/, "plain version line on the newest");
  assert.doesNotMatch(html.slice(html.indexOf("<h2>snapchain "), html.indexOf("</section>", html.indexOf("<h2>snapchain "))), /behind/, "the other network is judged on its own");
  assert.doesNotMatch(html, /<h2>quiet [\s\S]*?<p class="muted">v/, "no version line when the node reports none");
  assert.deepEqual(behind.version, { current: "0.17.4", latest: "0.17.5", behind: true });
  assert.deepEqual(current.version, { current: "0.17.5", latest: "0.17.5", behind: false });
  assert.deepEqual(none.version, { current: null, latest: "0.17.5", behind: false });
  assert.deepEqual(summary.versions, { snapchain: "0.12.0", hypersnap: "0.17.5" });
  assert.equal(summary.info["ohsnap"]?.version, "0.17.4", "info rows carry the raw version");
});
