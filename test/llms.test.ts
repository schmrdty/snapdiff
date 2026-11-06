import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server.js";
import { llmsTxt } from "../src/llms.js";
import { SqliteStore } from "../src/store/sqlite.js";

const node = (label: string, network: string) => ({ label, url: `http://${label}.test`, network, headers: {}, providers: [{ url: `http://${label}.test`, headers: {} }] });

test("llms.txt: generated from config, absolute links from the proxy headers", async () => {
  const cfg = { ...loadConfig(), nodes: [node("snapchain", "snapchain"), node("haatz", "hypersnap"), node("ohsnap", "hypersnap")], reference: "snapchain" };
  const txt = llmsTxt(cfg, "https://x.example");
  assert.match(txt, /^# snapdiff\n\n> /);
  assert.match(txt, /snapchain \(1 node\) vs hypersnap \(2 nodes\)/);
  assert.match(txt, /- snapchain: network snapchain \(reference/);
  assert.match(txt, /- ohsnap: network hypersnap\n/);
  assert.match(txt, /\(https:\/\/x\.example\/api\/summary\)/);
  assert.doesNotMatch(txt, /—/, "no em dashes");

  const store = new SqliteStore(":memory:");
  const app = buildApp(cfg, store);
  const res = await app.request("http://127.0.0.1:8787/llms.txt", { headers: { host: "snapdiff.example", "x-forwarded-proto": "https" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  const body = await res.text();
  assert.match(body, /Base URL: https:\/\/snapdiff\.example\n/);
  const plain = await app.request("http://127.0.0.1:8787/llms.txt");
  assert.match(await plain.text(), /Base URL: http:\/\/127\.0\.0\.1:8787\n/);
  await store.close();
});
