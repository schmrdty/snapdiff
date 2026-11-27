// Header of the dashboard (operator, 2026-11-26): the "Snapdiff" wordmark, an optional credit under it
// that opens a native popover with two profile links (no script, so the CSP hash in
// deploy/Caddyfile does not move), and a jump nav with no Nodes link, ordered Cards, Clients,
// Consensus, Stalls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseSiteCredit } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";

const node = (label: string, network: string) => ({ label, url: `https://${label}.test`, network, headers: {}, providers: [] });

test("parseSiteCredit: all three or none, https only, short text", () => {
  assert.equal(parseSiteCredit("", "", ""), null, "none set hides the line");
  assert.equal(parseSiteCredit("  ", " ", ""), null, "blank counts as unset");
  assert.deepEqual(parseSiteCredit(" by @me ", "https://q.test/me", "https://x.com/me"), { text: "by @me", quilcastUrl: "https://q.test/me", xUrl: "https://x.com/me" });
  assert.throws(() => parseSiteCredit("by @me", "https://q.test/me", ""), /must be set together/);
  assert.throws(() => parseSiteCredit("", "https://q.test/me", "https://x.com/me"), /must be set together/);
  assert.throws(() => parseSiteCredit("by @me", "http://q.test/me", "https://x.com/me"), /SITE_CREDIT_QUILCAST_URL must be an https URL/);
  assert.throws(() => parseSiteCredit("by @me", "https://q.test/me", "https://u:p@x.com/me"), /SITE_CREDIT_X_URL must be an https URL/);
  assert.throws(() => parseSiteCredit("by @me", "https://q.test/me", "not a url"), /SITE_CREDIT_X_URL must be an https URL/);
  assert.throws(() => parseSiteCredit("x".repeat(61), "https://q.test/me", "https://x.com/me"), /at most 60 characters/);
});

async function page(siteCredit: ReturnType<typeof parseSiteCredit>, path: string, withClients = false) {
  const cfg = {
    ...loadConfig(),
    siteCredit,
    nodes: [node("snapchain", "snapchain"), node("hypersnap", "hypersnap"), node("testnet-0", "hypersnap-testnet")],
    reference: "snapchain",
    references: { snapchain: "snapchain", hypersnap: "hypersnap", "hypersnap-testnet": "testnet-0" },
  };
  const health = [{ label: "T", network: "hypersnap-testnet", siteUrl: "https://t.test", siteHost: "t.test", healthUrl: null, status: "unknown", httpStatus: null, latencyMs: null, checkedAt: null, note: "" }];
  const store = new SqliteStore(":memory:");
  const html = await (await buildApp(cfg, store, withClients ? () => health as never : undefined).request(`http://x${path}`)).text();
  await store.close();
  return html;
}

test("header: the credit opens a popover with the two configured profile links, escaped", async () => {
  const html = await page({ text: "by <b>@me</b>", quilcastUrl: "https://q.test/me?a=1&b=2", xUrl: "https://x.com/me" }, "/");
  assert.match(html, /<h1 class="brand">Snapdiff<\/h1>\n<button class="credit" type="button" popovertarget="credit-pop">by &lt;b&gt;@me&lt;\/b&gt;<\/button>/, "credit sits directly under the title, text escaped");
  const pop = html.match(/<div id="credit-pop" class="credit-pop" popover>([\s\S]*?)<\/div>/)?.[1] ?? "";
  const links = [...pop.matchAll(/<a [^>]*href="([^"]+)" rel="noopener noreferrer" target="_blank">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(links, [["https://q.test/me?a=1&amp;b=2", "Quilcast"], ["https://x.com/me", "X"]]);
  assert.equal((html.match(/<script>/g) ?? []).length, 1, "still one inline script: the popover needs none");
});

test("header: no credit markup when the three keys are unset", async () => {
  const html = await page(null, "/");
  assert.match(html, /<h1 class="brand">Snapdiff<\/h1>/);
  assert.ok(!html.includes('id="credit-pop"') && !html.includes("popovertarget"), "the style block keeps its .credit rules; the markup is gone");
});

test("jump nav on the testnet tab: Cards, Clients, Stalls; no Nodes link", async () => {
  const html = await page(null, "/?net=testnet", true);
  const nav = html.match(/<nav class="jump" aria-label="Sections">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  const order = [...nav.matchAll(/href="#(\w+)">/g)].map((m) => m[1]);
  // Consensus appears only when a validator set is loaded for the network; this deployment has none.
  assert.deepEqual(order, ["nodes", "clients", "stalls"]);
});
