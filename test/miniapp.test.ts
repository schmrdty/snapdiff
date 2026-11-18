// Mini App surface: manifest only when the association is configured, embed meta tag on every
// page, the ready() module and the vendored SDK served from /static, images with the right
// shapes. Nothing goes online.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { embedJson, loadMiniApp, manifestJson } from "../src/miniapp.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";

const assoc = { MINIAPP_ASSOCIATION_HEADER: "eyJmaWQiOjF9", MINIAPP_ASSOCIATION_PAYLOAD: "eyJkb21haW4iOiJ4In0", MINIAPP_ASSOCIATION_SIGNATURE: "c2ln" };

test("loadMiniApp: name default and limit, association all-or-nothing and base64 only", () => {
  assert.deepEqual(loadMiniApp({}), { name: "snapdiff", association: null });
  assert.deepEqual(loadMiniApp(assoc).association, { header: "eyJmaWQiOjF9", payload: "eyJkb21haW4iOiJ4In0", signature: "c2ln" });
  assert.throws(() => loadMiniApp({ MINIAPP_ASSOCIATION_HEADER: "x" }), /set together/);
  assert.throws(() => loadMiniApp({ ...assoc, MINIAPP_ASSOCIATION_SIGNATURE: '"quoted"' }), /base64/);
  assert.throws(() => loadMiniApp({ MINIAPP_NAME: "x".repeat(33) }), /32 characters/);
});

test("embed and manifest JSON follow the spec shapes", () => {
  const cfg = { miniapp: loadMiniApp(assoc) };
  const e = JSON.parse(embedJson(cfg, "https://s.test", "/?net=testnet")) as { version: string; imageUrl: string; button: { title: string; action: Record<string, string> } };
  assert.equal(e.version, "1");
  assert.equal(e.imageUrl, "https://s.test/static/embed.png");
  assert.equal(e.button.action["type"], "launch_miniapp");
  assert.equal(e.button.action["url"], "https://s.test/?net=testnet");
  assert.ok(e.button.title.length <= 32);
  const m = manifestJson(cfg, "https://s.test") as { accountAssociation: unknown; miniapp: Record<string, unknown> };
  assert.deepEqual(m.accountAssociation, cfg.miniapp.association);
  assert.equal(m.miniapp["homeUrl"], "https://s.test/");
  assert.equal(m.miniapp["iconUrl"], "https://s.test/static/icon.png");
  assert.equal(manifestJson({ miniapp: loadMiniApp({}) }, "https://s.test"), null);
});

test("routes: manifest 404 without association and JSON with it; meta tags and the module on every page; static files served", async () => {
  const base = { ...loadConfig(), nodes: [{ label: "a", url: "http://a.test", network: "snapchain", headers: {}, providers: [] }, { label: "b", url: "http://b.test", network: "hypersnap", headers: {}, providers: [] }], reference: "a", references: { snapchain: "a", hypersnap: "b" } };
  const store = new SqliteStore(":memory:");
  const off = buildApp({ ...base, miniapp: loadMiniApp({}) }, store);
  const on = buildApp({ ...base, miniapp: loadMiniApp(assoc) }, store);
  const r404 = await off.request("http://x/.well-known/farcaster.json");
  const r200 = await on.request("http://x/.well-known/farcaster.json", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "snapdiff.example" } });
  const html = await (await on.request("http://x/", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "snapdiff.example" } })).text();
  const js = await on.request("http://x/static/miniapp.mjs");
  const sdk = await on.request("http://x/static/miniapp-sdk-0.4.0.mjs");
  const png = await on.request("http://x/static/icon.png");
  await store.close();
  assert.equal(r404.status, 404);
  assert.equal(r200.status, 200);
  const manifest = (await r200.json()) as { miniapp: { homeUrl: string } };
  assert.equal(manifest.miniapp.homeUrl, "https://snapdiff.example/");
  const meta = html.match(/<meta name="fc:miniapp" content="([^"]+)">/)?.[1] ?? "";
  const embed = JSON.parse(meta.replace(/&quot;/g, '"')) as { button: { action: { url: string } } };
  assert.equal(embed.button.action.url, "https://snapdiff.example/");
  assert.match(html, /<meta name="fc:frame" content="/, "legacy tag for older clients");
  assert.match(html, /<script type="module" src="\/static\/miniapp.mjs"><\/script>/);
  assert.equal((html.match(/<script>/g) ?? []).length, 1, "still exactly one inline script (CSP hash)");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  assert.equal(sdk.status, 200);
  assert.equal(png.status, 200);
  assert.match(png.headers.get("content-type") ?? "", /image\/png/);
});

test("static images have the shapes the spec asks for: square icon, square splash, 3:2 embed", () => {
  const size = (p: string) => {
    const b = readFileSync(new URL(`../static/${p}`, import.meta.url));
    assert.equal(b.toString("ascii", 1, 4), "PNG");
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: statSync(new URL(`../static/${p}`, import.meta.url)).size };
  };
  const icon = size("icon.png");
  const splash = size("splash.png");
  const embed = size("embed.png");
  assert.equal(icon.w, icon.h);
  assert.ok(icon.w >= 1024);
  assert.equal(splash.w, splash.h);
  assert.equal(splash.w, 200);
  assert.equal(embed.w * 2, embed.h * 3);
  assert.ok(embed.bytes < 300_000 && icon.bytes < 300_000);
});
