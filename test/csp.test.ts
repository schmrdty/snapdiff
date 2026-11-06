// The Caddy CSP allows exactly one script: the dashboard's node pager, by hash. If the
// inline script changes, the hash in deploy/Caddyfile must change with it or the browser
// blocks the pager and every node card shows at once (seen live on 2026-11-06).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";

test("CSP: the Caddyfile script hash matches the dashboard's inline script", async () => {
  const cfg = { ...loadConfig(), nodes: [{ label: "a", url: "http://a.test", network: "snapchain", headers: {}, providers: [] }, { label: "b", url: "http://b.test", network: "hypersnap", headers: {}, providers: [] }], reference: "a" };
  const store = new SqliteStore(":memory:");
  const html = await (await buildApp(cfg, store).request("http://x/")).text();
  await store.close();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  assert.equal(scripts.length, 1, "one inline script, the node pager");
  const hash = `'sha256-${createHash("sha256").update(scripts[0] ?? "").digest("base64")}'`;
  const caddy = readFileSync(new URL("../deploy/Caddyfile", import.meta.url), "utf8");
  const csp = caddy.match(/Content-Security-Policy "([^"]+)"/)?.[1] ?? "";
  const scriptSrc = csp.match(/script-src ([^;]+);/)?.[1] ?? "";
  assert.equal(scriptSrc, hash, `deploy/Caddyfile script-src must be ${hash}`);
});
