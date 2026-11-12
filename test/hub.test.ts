// Provider failover in HubClient: a refused primary benches itself and the fallback answers;
// the snapshot says who answered and why the primary did not. Fetch is faked; nothing goes online.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HubClient, explainStatus } from "../src/hub.js";

const INFO = JSON.stringify({ dbStats: { numFidRegistrations: 10 }, numShards: 2, shardInfos: [{ shardId: 1, maxHeight: 5, blockDelay: 1 }] });
const res = (status: number, body = ""): Response => ({ status, text: async () => body }) as unknown as Response;

const fakeFetch = (byHost: Record<string, () => Response>, calls: string[]) =>
  (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.host);
    return byHost[u.host]!();
  }) as typeof fetch;

test("explainStatus: short, honest, keeps the code", () => {
  assert.match(explainStatus(402, 1000), /out of credits.*402/);
  assert.match(explainStatus(401, 1000), /turned our key away/);
  assert.match(explainStatus(503, 1000), /bad day.*503/);
  assert.equal(explainStatus(null, 10_000), "no answer within 10s");
});

test("primary out of credits: fallback answers, snapshot names it, primary is retried after the bench", async () => {
  const calls: string[] = [];
  let now = 1_000_000;
  let primaryStatus = 402;
  const hub = new HubClient(
    "snapchain",
    [{ url: "https://paid.example", headers: { "x-api-key": "k" } }, { url: "https://snap.farcaster.xyz:3381", headers: {} }],
    1000,
    { providerRetryMs: 60_000, now: () => now, fetchImpl: fakeFetch({ "paid.example": () => res(primaryStatus), "snap.farcaster.xyz:3381": () => res(200, INFO) }, calls) },
  );
  const i = await hub.info();
  assert.equal(i.reachable, true);
  assert.equal(i.provider, "snap.farcaster.xyz:3381");
  assert.match(i.note ?? "", /paid\.example: out of credits.*answering via snap\.farcaster\.xyz:3381/);
  assert.deepEqual(calls, ["paid.example", "snap.farcaster.xyz:3381"]);
  // Within the bench window the primary is not asked again.
  calls.length = 0;
  await hub.info();
  assert.deepEqual(calls, ["snap.farcaster.xyz:3381"]);
  // After the window the fallback still answers first (it is active), so the primary is left alone
  // until the fallback fails; when it does and the primary recovered, the primary takes over.
  now += 61_000;
  primaryStatus = 200;
  const flaky = new HubClient("snapchain", hub.providers, 1000, {
    providerRetryMs: 60_000,
    now: () => now,
    fetchImpl: fakeFetch({ "paid.example": () => res(200, INFO), "snap.farcaster.xyz:3381": () => res(503) }, calls),
  });
  const j = await flaky.info();
  assert.equal(j.provider, "paid.example");
  assert.equal(j.note, null);
});

test("a single provider that timed out once is asked again on the next check, not after the bench", async () => {
  let now = 0;
  let fail = true;
  const calls: string[] = [];
  const hub = new HubClient("ohsnap", [{ url: "https://ohsnap.example", headers: {} }], 1000, {
    providerRetryMs: 600_000,
    now: () => now,
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(new URL(String(input)).host);
      if (fail) throw new Error("aborted");
      return res(200, INFO);
    }) as typeof fetch,
  });
  const miss = await hub.info();
  assert.equal(miss.reachable, false);
  assert.equal(miss.error, "ohsnap.example: no answer within 1s");
  fail = false;
  now += 60_000;
  const back = await hub.info();
  assert.equal(back.reachable, true, "one slow answer does not hide the node for providerRetryMs");
  assert.equal(calls.length, 2, "the second check really asked the node");
});

test("a 200 without shardInfos is not a node: down, with a message naming the cause", async () => {
  const hub = new HubClient("homiehouse", [{ url: "https://rpc.example", headers: {} }], 1000, {
    fetchImpl: fakeFetch({ "rpc.example": () => res(200, JSON.stringify({ online: true })) }, []),
  });
  const snap = await hub.info();
  assert.equal(snap.reachable, false);
  assert.deepEqual(snap.shards, []);
  assert.equal(snap.error, "rpc.example: answered, but not with a Snapchain API (no shardInfos in /v1/info)");
  const ok = new HubClient("x", [{ url: "https://a.example", headers: {} }], 1000, { fetchImpl: fakeFetch({ "a.example": () => res(200, INFO) }, []) });
  assert.equal((await ok.info()).reachable, true, "a real info body is unchanged");
});

test("every provider refusing: unreachable with the primary's reason, no stack traces", async () => {
  const hub = new HubClient("snapchain", [{ url: "https://paid.example", headers: {} }, { url: "https://b.example", headers: {} }], 1000, {
    fetchImpl: fakeFetch({ "paid.example": () => res(402), "b.example": () => res(403) }, []),
  });
  const i = await hub.info();
  assert.equal(i.reachable, false);
  assert.equal(i.provider, null);
  assert.match(i.error ?? "", /b\.example: the provider turned our key away \(HTTP 403\)|paid\.example: out of credits/);
});

test("a not-found is a normal answer, not a reason to fail over", async () => {
  const calls: string[] = [];
  const hub = new HubClient("x", [{ url: "https://a.example", headers: {} }, { url: "https://b.example", headers: {} }], 1000, {
    fetchImpl: fakeFetch({ "a.example": () => res(404, JSON.stringify({ errCode: "not_found" })), "b.example": () => res(200, "{}") }, calls),
  });
  assert.equal(await hub.hasCast(1, "0x01"), false);
  assert.deepEqual(calls, ["a.example"]);
});
