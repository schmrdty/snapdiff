// Published releases: a Docker Hub tag list gives the newest numeric tag per network. The
// dashboard shows a "published" pill when the project has shipped past a node and no node on
// its network runs it yet; /api/summary and /api/node carry the same. A fake fetch stands in
// for the registry; nothing here goes online.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadReleaseFeeds } from "../src/config.js";
import { DEFAULT_RELEASE_FEEDS, fetchRelease, pickRelease, RELEASE_MAX_BODY, ReleaseMonitor, type FetchLike } from "../src/releases.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { InfoSnapshot } from "../src/types.js";

const hub = (tags: Array<[string, string]>) => JSON.stringify({ count: tags.length, results: tags.map(([name, last_updated]) => ({ name, last_updated, digest: "sha256:x" })) });
const respond = (status: number, body: string): FetchLike => async () => new Response(body, { status, headers: { "content-type": "application/json" } });
const failWith = (err: Error): FetchLike => async () => { throw err; };

const node = (label: string, network: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [] });
const snap = (side: string, version: string | null): InfoSnapshot => ({
  side, at: Date.now(), reachable: true, provider: side, note: null, maxBlockDelay: 1, numShards: 2, numFidRegistrations: 1,
  shards: [{ shardId: 1, maxHeight: 10, blockDelay: 1 }], error: null, version,
});

test("pickRelease: newest numeric tag only; latest, nightly, pre-* and malformed entries never count", () => {
  const body = JSON.parse(hub([["latest", "2026-11-14T15:01:00Z"], ["nightly-0.17.13-abc", "2026-11-14T16:00:00Z"], ["0.17.12", "2026-11-14T15:01:00Z"], ["pre-main-884a778", "2026-11-11T22:44:00Z"], ["0.17.9", "2026-11-14T12:47:00Z"], ["0.9.9", "2026-01-01T00:00:00Z"]]));
  assert.deepEqual(pickRelease(body), { version: "0.17.12", publishedAt: Date.parse("2026-11-14T15:01:00Z") }, "numeric order, not string order (0.9.9 loses)");
  assert.equal(pickRelease(JSON.parse(hub([["latest", "x"], ["nightly-latest", "x"]]))), null, "no release tag");
  assert.equal(pickRelease({ results: [{ name: 42 }, null, "0.1.0"] }), null, "junk entries are skipped");
  assert.equal(pickRelease([]), null);
  assert.equal(pickRelease("0.17.12"), null);
  assert.deepEqual(pickRelease({ results: [{ name: "1.2.3", last_updated: "not a date" }] }), { version: "1.2.3", publishedAt: null }, "a bad timestamp is null, the version still counts");
});

test("fetchRelease: every failure is a fixed phrase, never response text", async () => {
  assert.deepEqual(await fetchRelease("https://f.test", respond(200, hub([["0.17.12", "2026-11-14T15:01:00Z"]]))), { release: { version: "0.17.12", publishedAt: Date.parse("2026-11-14T15:01:00Z") }, error: null });
  assert.deepEqual(await fetchRelease("https://f.test", respond(530, "<html>cloudflare says no</html>")), { release: null, error: "HTTP 530" });
  assert.deepEqual(await fetchRelease("https://f.test", respond(200, "<html>not json</html>")), { release: null, error: "not JSON" });
  assert.deepEqual(await fetchRelease("https://f.test", respond(200, hub([["latest", "x"]]))), { release: null, error: "no release tag" });
  assert.deepEqual(await fetchRelease("https://f.test", respond(200, "[" + "1,".repeat(RELEASE_MAX_BODY / 2) + "1]")), { release: null, error: "body too large" });
  assert.deepEqual(await fetchRelease("https://f.test", failWith(Object.assign(new Error("t"), { name: "TimeoutError" }))), { release: null, error: "timeout" });
  assert.deepEqual(await fetchRelease("https://f.test", failWith(new Error("ECONNREFUSED"))), { release: null, error: "unreachable" });
});

test("ReleaseMonitor: a failed round keeps the last known release and records the error; a new tag is logged once", async () => {
  let body = hub([["0.17.11", "2026-11-14T14:00:00Z"]]);
  let status = 200;
  const fetchFn: FetchLike = async () => new Response(body, { status });
  const logs: string[] = [];
  const m = new ReleaseMonitor({ hypersnap: "https://f.test" }, fetchFn, (s) => logs.push(s), () => 1000);
  assert.deepEqual(m.snapshot(), { hypersnap: { network: "hypersnap", version: null, publishedAt: null, checkedAt: null, error: null } }, "nothing known before the first round");
  await m.runAll();
  assert.deepEqual(m.snapshot()["hypersnap"], { network: "hypersnap", version: "0.17.11", publishedAt: Date.parse("2026-11-14T14:00:00Z"), checkedAt: 1000, error: null });
  status = 503;
  await m.runAll();
  assert.deepEqual(m.snapshot()["hypersnap"], { network: "hypersnap", version: "0.17.11", publishedAt: Date.parse("2026-11-14T14:00:00Z"), checkedAt: 1000, error: "HTTP 503" }, "the last release survives a failed fetch");
  status = 200;
  body = hub([["0.17.12", "2026-11-14T15:01:00Z"], ["0.17.11", "2026-11-14T14:00:00Z"]]);
  await m.runAll();
  assert.equal(m.snapshot()["hypersnap"]?.version, "0.17.12");
  assert.deepEqual(logs, ["[releases] hypersnap: none -> 0.17.11", "[releases] hypersnap: HTTP 503", "[releases] hypersnap: 0.17.11 -> 0.17.12"]);
});

test("loadReleaseFeeds: built-in feeds for known networks, RELEASE_FEED_<NETWORK> overrides or turns off, unknown networks are skipped", () => {
  const saved = { ...process.env };
  try {
    delete process.env["RELEASE_FEED_HYPERSNAP"];
    delete process.env["RELEASE_FEED_SNAPCHAIN"];
    assert.deepEqual(loadReleaseFeeds(["snapchain", "hypersnap", "hypersnap", "other"]), { snapchain: DEFAULT_RELEASE_FEEDS["snapchain"], hypersnap: DEFAULT_RELEASE_FEEDS["hypersnap"] });
    process.env["RELEASE_FEED_HYPERSNAP"] = "off";
    process.env["RELEASE_FEED_SNAPCHAIN"] = "https://mirror.test/tags";
    assert.deepEqual(loadReleaseFeeds(["snapchain", "hypersnap"]), { snapchain: "https://mirror.test/tags" });
    process.env["RELEASE_FEED_SNAPCHAIN"] = "http://mirror.test/tags";
    assert.throws(() => loadReleaseFeeds(["snapchain"]), /https URL/);
  } finally {
    process.env = saved;
  }
});

test("page and API: published pill only when the project is ahead of the node and nobody runs it yet; summary and node carry releases", async () => {
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap"), node("ohsnap", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  await store.recordInfo(snap("snapchain", "0.16.0"));
  await store.recordInfo(snap("hypersnap", "0.17.11"));
  await store.recordInfo(snap("ohsnap", "0.17.10"));
  const rel = { hypersnap: { network: "hypersnap", version: "0.17.12", publishedAt: Date.now() - 7_200_000, checkedAt: Date.now(), error: null }, snapchain: { network: "snapchain", version: "0.16.0", publishedAt: null, checkedAt: Date.now(), error: null } };
  const app = buildApp(cfg, store, undefined, () => rel);
  const html = await (await app.request("http://x/?view=cards")).text();
  const summary = (await (await app.request("http://x/api/summary")).json()) as { releases: unknown };
  const nodeJson = (await (await app.request("http://x/api/node/ohsnap")).json()) as { release: unknown };
  const off = await (await buildApp(cfg, store).request("http://x/api/summary")).json() as { releases: unknown };
  await store.close();
  assert.match(html, /<h2>hypersnap [\s\S]*?<p class="muted">v0\.17\.11 <span class="pill warn" title="published 2h ago, no node on this network runs it yet">0\.17\.12 published<\/span><\/p>/, "the newest node is still behind the publish");
  assert.match(html, /<h2>ohsnap [\s\S]*?<p class="muted">v0\.17\.10 <span class="pill bad" title="newest on this network: 0\.17\.11">behind 0\.17\.11<\/span> <span class="pill warn"[^>]*>0\.17\.12 published<\/span><\/p>/, "behind a peer and behind the publish: both pills, different numbers");
  assert.match(html, /<h2>snapchain [\s\S]*?<p class="muted">v0\.16\.0<\/p>/, "running the published version: no pill");
  assert.deepEqual(summary.releases, rel);
  assert.deepEqual(nodeJson.release, rel.hypersnap);
  assert.deepEqual(off.releases, {}, "no monitor: an empty object, never an error");
});

test("page: when a peer already runs the published version the behind pill carries the number alone", async () => {
  const cfg = { ...loadConfig(), nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap"), node("ohsnap", "hypersnap")], reference: "snapchain", references: { snapchain: "snapchain", hypersnap: "hypersnap" } };
  const store = new SqliteStore(":memory:");
  await store.recordInfo(snap("snapchain", "0.16.0"));
  await store.recordInfo(snap("hypersnap", "0.17.12"));
  await store.recordInfo(snap("ohsnap", "0.17.11"));
  const rel = { hypersnap: { network: "hypersnap", version: "0.17.12", publishedAt: Date.now(), checkedAt: Date.now(), error: null } };
  const html = await (await buildApp(cfg, store, undefined, () => rel).request("http://x/?view=cards")).text();
  await store.close();
  assert.match(html, /<h2>ohsnap [\s\S]*?<p class="muted">v0\.17\.11 <span class="pill bad" title="newest on this network: 0\.17\.12">behind 0\.17\.12<\/span><\/p>/, "one pill, not two with the same number");
  assert.doesNotMatch(html, /published<\/span>/);
});
