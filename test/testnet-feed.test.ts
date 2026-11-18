// Testnet cast explorer: FIDs from every data shard, newest casts per FID, merged newest
// first; the Testnet tab shows them under the node cards; the API carries the same. Hubs are
// fakes; nothing goes online.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import type { HubClient } from "../src/hub.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";
import { castsFromMessages, FEED_KEEP, TestnetFeed } from "../src/testnet-feed.js";
import type { HubMessage, InfoSnapshot } from "../src/types.js";

const cast = (fid: number, ts: number, text: string, hash: string, extra: Record<string, unknown> = {}): HubMessage =>
  ({ hash, data: { type: "MESSAGE_TYPE_CAST_ADD", fid, timestamp: ts, network: "FARCASTER_NETWORK_TESTNET", castAddBody: { text, embeds: [], ...extra } } }) as HubMessage;
const h = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

test("castsFromMessages: casts only, hash and numbers checked, text clipped, reply target reduced to a prefix or host", () => {
  const rows = castsFromMessages("hypersnap-testnet", [
    cast(4294967296, 185486783, "hello", h(1)),
    cast(4294967296, 185486790, "x".repeat(400), h(2), { parentUrl: "https://example.test/channel/x" }),
    cast(4294967296, 185486791, "reply", h(3), { parentCastId: { fid: 1, hash: h(1) } }),
    { hash: "not-a-hash", data: { type: "MESSAGE_TYPE_CAST_ADD", fid: 1, timestamp: 1, castAddBody: { text: "bad" } } } as HubMessage,
    { hash: h(9), data: { type: "MESSAGE_TYPE_REACTION_ADD", fid: 1, timestamp: 1 } } as HubMessage,
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { network: "hypersnap-testnet", fid: 4294967296, at: (185486783 + 1_609_459_200) * 1000, text: "hello", hash: h(1), replyTo: null, embeds: 0 });
  assert.equal(rows[1]?.text.length, 321, "clipped to 320 plus the ellipsis");
  assert.equal(rows[1]?.replyTo, "example.test");
  assert.equal(rows[2]?.replyTo, `${h(1).slice(0, 10)}…`);
});

test("TestnetFeed: fids from every data shard, one page of newest casts per fid, merged newest first and capped; a failed round keeps the last casts", async () => {
  let fail = false;
  const calls: string[] = [];
  const hub = {
    fids: async (shard: number) => {
      calls.push(`fids:${shard}`);
      if (fail) throw new Error("boom");
      return shard === 1 ? [4294967296, 4294967298] : [4294967297, 4294967296];
    },
    recentCasts: async (fid: number) => {
      calls.push(`casts:${fid}`);
      const n = fid - 4294967295;
      return Array.from({ length: n === 3 ? FEED_KEEP : 2 }, (_, i) => cast(fid, 185486000 + n * 10 + i, `cast ${n}.${i}`, h(n * 1000 + i)));
    },
  } as unknown as HubClient;
  const logs: string[] = [];
  const feed = new TestnetFeed({ "hypersnap-testnet": { hub, source: "testnet-0", shards: () => [1, 2] } }, (m) => logs.push(m), () => 1000);
  assert.deepEqual(feed.snapshot()["hypersnap-testnet"], { network: "hypersnap-testnet", source: "testnet-0", casts: [], fids: 0, checkedAt: null, error: null });
  await feed.runAll();
  const s = feed.snapshot()["hypersnap-testnet"]!;
  assert.equal(s.fids, 3, "three distinct fids across both shards");
  assert.equal(s.casts.length, FEED_KEEP, "capped");
  assert.equal(s.casts[0]?.text, "cast 3.99", "newest first");
  assert.ok(s.casts.every((c, i, a) => i === 0 || a[i - 1]!.at >= c.at));
  assert.deepEqual(calls.filter((c) => c.startsWith("fids")), ["fids:1", "fids:2"]);
  assert.deepEqual(calls.filter((c) => c.startsWith("casts")).sort(), ["casts:4294967296", "casts:4294967297", "casts:4294967298"]);
  assert.equal(s.checkedAt, 1000);
  fail = true;
  await feed.runAll();
  const s2 = feed.snapshot()["hypersnap-testnet"]!;
  assert.equal(s2.error, "node did not answer");
  assert.equal(s2.casts.length, FEED_KEEP, "last casts survive a failed round");
  assert.ok(logs.some((l) => l.includes("[testnet-feed] hypersnap-testnet: 3 fids")));
  assert.ok(logs.some((l) => l.endsWith("node did not answer")));
});

test("page and API: the casts card sits under the testnet nodes only; /api/testnet/casts carries the snapshot", async () => {
  const node = (label: string, network: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [] });
  const snap = (side: string): InfoSnapshot => ({ side, at: Date.now(), reachable: true, provider: side, note: null, maxBlockDelay: 1, numShards: 2, numFidRegistrations: 1, shards: [{ shardId: 1, maxHeight: 10, blockDelay: 1 }], error: null, version: "0.17.15" });
  const cfg = { ...loadConfig(), nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap"), node("testnet-0", "hypersnap-testnet")], reference: "snapchain", references: { snapchain: "snapchain", hypersnap: "hypersnap", "hypersnap-testnet": "testnet-0" } };
  const store = new SqliteStore(":memory:");
  for (const l of ["snapchain", "hypersnap", "testnet-0"]) await store.recordInfo(snap(l));
  const feedSnap = { "hypersnap-testnet": { network: "hypersnap-testnet", source: "testnet-0", fids: 1, checkedAt: Date.now(), error: null, casts: [{ network: "hypersnap-testnet", fid: 4294967296, at: Date.now() - 60_000, text: "first cast <b>on</b> the testnet", hash: h(0xb12d), replyTo: null, embeds: 0 }] } };
  const app = buildApp(cfg, store, undefined, undefined, () => feedSnap);
  const testnet = await (await app.request("http://x/?net=testnet")).text();
  const main = await (await app.request("http://x/")).text();
  const api = (await (await app.request("http://x/api/testnet/casts")).json()) as { feeds: typeof feedSnap };
  const off = (await (await buildApp(cfg, store).request("http://x/api/testnet/casts")).json()) as { feeds: unknown };
  await store.close();
  const nodesAt = testnet.indexOf('id="nodes"');
  const castsAt = testnet.indexOf("<h2>Casts on hypersnap-testnet</h2>");
  assert.ok(nodesAt > 0 && castsAt > nodesAt, "the casts card comes after the node cards");
  assert.match(testnet, /first cast &lt;b&gt;on&lt;\/b&gt; the testnet/, "text is escaped");
  assert.match(testnet, /<td>4294967296<\/td>/);
  assert.match(testnet, /1 account/);
  assert.doesNotMatch(main, /Casts on hypersnap-testnet/, "nothing on the mainnet tab");
  assert.deepEqual(api.feeds, feedSnap);
  assert.deepEqual(off.feeds, {}, "no feed: an empty object, never an error");
});
