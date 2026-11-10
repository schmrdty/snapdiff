// Dashboard shard-stall list: one line per node and shard, newest first, showing that pair's
// latest stall whatever its age, with a count and total time over the last 7 days; a pair with
// several stalls expands with <details>, a pair with one is a plain line. No script is involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";

const node = (label: string, network: string, name?: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [], ...(name === undefined ? {} : { name }) });

test("stall list: one line per node and shard with its latest stall, 7 day counts, expandable groups", async () => {
  const cfg = {
    ...loadConfig(),
    nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap", "haatz"), node("ohsnap", "hypersnap"), node("sizzle", "hypersnap")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap" },
  };
  const store = new SqliteStore(":memory:");
  const now = Date.now();
  const h = 3_600_000;
  const stall = (side: string, shardId: number, startedAt: number) => store.startStall({ side, shardId, stuckHeight: 100, peer: "snapchain", peerHeightStart: 110, startedAt });
  // ohsnap shard 2: three stalls today, the newest still open.
  await store.endStall(await stall("ohsnap", 2, now - 5 * h), now - 5 * h + 60_000, 170);
  await store.endStall(await stall("ohsnap", 2, now - 3 * h), now - 3 * h + 120_000, 180);
  await stall("ohsnap", 2, now - 10 * 60_000);
  // ohsnap shard 1: one ended stall today.
  await store.endStall(await stall("ohsnap", 1, now - 2 * h), now - 2 * h + 30_000, 120);
  // haatz shard 0: one stall two days ago (inside the week) and one twelve days ago (outside it).
  await store.endStall(await stall("hypersnap", 0, now - 12 * 24 * h), now - 12 * 24 * h + 60_000, 125);
  await store.endStall(await stall("hypersnap", 0, now - 48 * h), now - 48 * h + 60_000, 130);
  // snapchain shard 1: one stall twelve days ago, nothing since.
  await store.endStall(await stall("snapchain", 1, now - 12 * 24 * h), now - 12 * 24 * h + 90_000, 140);
  // sizzle: opened 30 h ago and still open.
  await stall("sizzle", 0, now - 30 * h);
  const html = await (await buildApp(cfg, store).request("http://x/")).text();
  await store.close();

  const section = html.slice(html.indexOf("<h2>Shard stalls"), html.indexOf("<h2>Unexplained"));
  const lines = [...section.matchAll(/<(details class="group"|div class="row")><(?:summary|span)>(?:<span>)?([^<]+)<\/span><span>(\d+)<\/span>/g)].map((m) => [m[1]!.startsWith("details") ? "group" : "row", m[2], m[3]]);
  assert.deepEqual(lines, [["group", "ohsnap", "2"], ["row", "ohsnap", "1"], ["row", "sizzle", "0"], ["group", "haatz", "0"], ["row", "snapchain", "1"]], "every pair that ever stalled has one line, newest latest stall first, display names used");
  assert.match(section, /<summary><span>ohsnap<\/span><span>2<\/span>(<span>[^<]*<\/span>){1}<span><span class="pill bad">ongoing [^<]*<\/span><\/span>/, "the group line shows the latest stall, which is ongoing");
  assert.match(section, /<span>3 stalls, [^<]+<\/span><\/summary>/, "count and total time over the week");
  assert.equal((section.match(/<details class="group"><summary><span>ohsnap<\/span><span>2<\/span>[\s\S]*?<\/details>/)?.[0].match(/<tr><td>/g) ?? []).length, 3, "the expanded table lists all three stalls");
  assert.match(section, /<div class="row"><span>sizzle<\/span><span>0<\/span><span>[^<]*<\/span><span><span class="pill bad">ongoing 30\.0h/, "an open stall stays ongoing on its line");
  assert.match(section, /<span>1 stall, [^<]+<\/span><\/div>/, "a single stall is not expandable");
  assert.match(section, /<summary><span>haatz<\/span><span>0<\/span>(<span>[^<]*<\/span>){6}<span>1 stall, 60s<\/span><\/summary>/, "the week count excludes the twelve-day-old stall but the group still expands to both");
  assert.equal((section.match(/<details class="group"><summary><span>haatz<\/span>[\s\S]*?<\/details>/)?.[0].match(/<tr><td>/g) ?? []).length, 2);
  assert.match(section, /<div class="row"><span>snapchain<\/span><span>1<\/span>(<span>[^<]*<\/span>){6}<span>none<\/span><\/div>/, "an old pair keeps its line, with no stalls in the week");
  assert.match(section, /<span class="pill bad">2 ongoing<\/span>/, "the heading counts open stalls");
  assert.doesNotMatch(section, /<script/, "no script added: the CSP hash is unchanged");
});
