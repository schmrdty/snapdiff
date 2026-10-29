// Client health: config validation and the status derivation contract.
// A fake fetch stands in for the network; nothing here goes online.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClient, ClientHealthMonitor, HEALTH_MAX_BODY, parseClients, type ClientSpec, type FetchLike } from "../src/clients.js";

const spec = (over: Partial<ClientSpec> = {}): ClientSpec => ({
  label: "Example",
  network: "both",
  siteUrl: "https://example.org",
  healthUrl: "https://health.example.org/health",
  ...over,
});

/** A row with no health endpoint (the key is absent, not undefined: exactOptionalPropertyTypes). */
const LINK_ONLY: ClientSpec = { label: "Example", network: "both", siteUrl: "https://example.org" };

const respond = (status: number, body: string): FetchLike => async () => new Response(body, { status, headers: { "content-type": "application/json" } });
const failWith = (err: Error): FetchLike => async () => { throw err; };

test("parseClients accepts the documented shape and rejects unsafe entries", () => {
  const ok = parseClients(JSON.stringify([spec(), { label: "Link only", network: "snapchain", siteUrl: "https://a.example" }]));
  assert.equal(ok.length, 2);
  assert.equal(ok[1]?.healthUrl, undefined);
  for (const [bad, why] of [
    [[{ ...spec(), siteUrl: "http://example.org" }], "http siteUrl"],
    [[{ ...spec(), healthUrl: "http://health.example.org" }], "http healthUrl"],
    [[{ ...spec(), siteUrl: "https://user:pw@example.org" }], "credentials in URL"],
    [[{ ...spec(), network: "farcaster" }], "unknown network"],
    [[{ ...spec(), label: "<script>" }], "label is printable ASCII but we still escape; this one is fine"],
    [[{ ...spec(), statusPath: "a.b.c.d.e.f.g" }], "path too deep"],
    [[{ ...spec(), statusPath: "status;drop" }], "path characters"],
    [[spec(), spec()], "duplicate label"],
    [{ not: "an array" }, "not an array"],
  ] as const) {
    if (why.startsWith("label is printable")) {
      assert.doesNotThrow(() => parseClients(JSON.stringify(bad)));
      continue;
    }
    assert.throws(() => parseClients(JSON.stringify(bad)), why);
  }
  assert.throws(() => parseClients("{nope"), "invalid JSON");
});

test("status derivation: ok, degraded, down, unknown", async () => {
  assert.equal((await checkClient(spec(), respond(200, '{"status":"ok"}'))).status, "ok");
  assert.equal((await checkClient(spec(), respond(200, '{"status":"Healthy"}'))).status, "ok", "case-insensitive");
  const degraded = await checkClient(spec(), respond(200, '{"status":"maintenance"}'));
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.note, 'status "maintenance"');
  const down = await checkClient(spec(), respond(503, '{"status":"ok"}'));
  assert.equal(down.status, "down");
  assert.equal(down.note, "HTTP 503");
  assert.equal((await checkClient(spec(), respond(200, "not json"))).status, "unknown");
  assert.equal((await checkClient(spec(), respond(200, '{"other":1}'))).note, "no status field");
  assert.equal((await checkClient(spec({ statusPath: null }), respond(200, "<html>fine</html>"))).status, "ok", "statusPath null = any 200");
  const nested = await checkClient(spec({ statusPath: "data.api.state", okValues: ["green"] }), respond(200, '{"data":{"api":{"state":"GREEN"}}}'));
  assert.equal(nested.status, "ok");
  assert.equal((await checkClient(spec(), respond(200, '{"status":true}'))).status, "ok");
  assert.equal((await checkClient(spec(), respond(200, '{"status":false}'))).status, "degraded");
});

test("failures become fixed-phrase notes, never raw error text", async () => {
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.deepEqual(pick(await checkClient(spec(), failWith(timeout))), { status: "down", note: "timeout" });
  assert.deepEqual(pick(await checkClient(spec(), failWith(new TypeError("fetch failed: unexpected redirect")))), { status: "down", note: "redirect refused" });
  assert.deepEqual(pick(await checkClient(spec(), failWith(new TypeError("fetch failed")))), { status: "down", note: "unreachable" });
  const big = await checkClient(spec(), respond(200, JSON.stringify({ status: "ok", pad: "x".repeat(HEALTH_MAX_BODY) })));
  assert.deepEqual(pick(big), { status: "unknown", note: "body too large" });
  const linkOnly = await checkClient(LINK_ONLY);
  assert.deepEqual(pick(linkOnly), { status: "unknown", note: "no health endpoint configured" });
  assert.equal(linkOnly.checkedAt, null);
});

test("a long status value is clipped and nothing else from the body is kept", async () => {
  const r = await checkClient(spec(), respond(200, JSON.stringify({ status: "x".repeat(200), secret: "do not keep" })));
  assert.equal(r.status, "degraded");
  assert.equal(r.note.length, 'status ""'.length + 40);
  assert.ok(!JSON.stringify(r).includes("do not keep"));
});

test("the monitor holds the latest result per client and logs status changes", async () => {
  let n = 0;
  const flapping: FetchLike = async () => new Response(JSON.stringify({ status: n++ === 0 ? "ok" : "maintenance" }), { status: 200 });
  const logs: string[] = [];
  const m = new ClientHealthMonitor([spec({ label: "A" }), { ...LINK_ONLY, label: "B" }], flapping, (s) => logs.push(s));
  assert.deepEqual(m.snapshot().map((h) => h.status), ["unknown", "unknown"]);
  await m.runAll();
  assert.deepEqual(m.snapshot().map((h) => h.status), ["ok", "unknown"]);
  await m.runAll();
  assert.deepEqual(m.snapshot().map((h) => h.status), ["degraded", "unknown"]);
  assert.ok(logs.some((l) => l.includes("A: ok -> degraded")));
  assert.equal(m.snapshot()[0]?.siteHost, "example.org");
});

function pick(h: { status: string; note: string }): { status: string; note: string } {
  return { status: h.status, note: h.note };
}
