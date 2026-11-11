// Private nodes: NODE_<K>_PRIVATE=1 keeps a node's host and URL out of everything snapdiff
// publishes (card, API snapshot, notes, errors), so an operator on a bare IP can be listed by a
// chosen label such as "hypersnape.node" (dots are allowed in labels for exactly this reason).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadNodes } from "../src/config.js";
import { HubClient } from "../src/hub.js";
import { buildApp } from "../src/server.js";
import { SqliteStore } from "../src/store/sqlite.js";

const IP = "203.0.113.7";
const INFO = JSON.stringify({ dbStats: { numFidRegistrations: 10 }, numShards: 2, shardInfos: [{ shardId: 1, maxHeight: 5, blockDelay: 1 }] });
const res = (status: number, body = ""): Response => ({ status, text: async () => body }) as unknown as Response;
const fakeFetch = (byHost: Record<string, () => Response>) =>
  (async (input: string | URL | Request) => byHost[new URL(String(input)).host]!()) as typeof fetch;

test("loadNodes: dotted label, env key with underscores, PRIVATE flag; networks stay dash-only", () => {
  const env = {
    NODES: "snapchain,hypersnape.node",
    NODE_SNAPCHAIN_URL: "https://sc.example",
    NODE_HYPERSNAPE_NODE_URL: `http://${IP}:3381`,
    NODE_HYPERSNAPE_NODE_PRIVATE: "1",
  };
  const { nodes } = loadNodes(env);
  assert.deepEqual(nodes.map((n) => [n.label, n.network, n.private ?? false]), [["snapchain", "snapchain", false], ["hypersnape.node", "hypersnap", true]]);
  assert.equal(loadNodes({ ...env, NODE_HYPERSNAPE_NODE_PRIVATE: "0" }).nodes[1]!.private, undefined);
  assert.equal(loadNodes({ ...env, NODE_HYPERSNAPE_NODE_VALIDATOR: "yes" }).nodes[1]!.validator, true, "VALIDATOR flag reads like PRIVATE");
  assert.equal(loadNodes(env).nodes[1]!.validator, undefined, "unset means read-only");
  assert.throws(() => loadNodes({ ...env, NODE_HYPERSNAPE_NODE_NETWORK: "hyper.snap" }), /network .* letters, digits, or dashes/);
  assert.throws(() => loadNodes({ ...env, NODES: "snapchain,.node", NODE__NODE_URL: "https://x", NODE__NODE_NETWORK: "hypersnap" }), /label/);
});

test("HubClient with displayName: provider, note, and errors name the label, never the host", async () => {
  let primary = 402;
  const hub = new HubClient("hypersnape.node", [{ url: `http://${IP}:3381`, headers: {} }, { url: "https://backup.example", headers: {} }], 1000, {
    providerRetryMs: 60_000,
    displayName: "hypersnape.node",
    fetchImpl: fakeFetch({ [`${IP}:3381`]: () => res(primary), "backup.example": () => res(200, INFO) }),
  });
  const up = await hub.info();
  assert.equal(up.provider, "hypersnape.node (provider 2)");
  assert.equal(up.note, "hypersnape.node: out of credits: the hosted provider wants to be paid before it answers (HTTP 402); answering via hypersnape.node (provider 2)");
  assert.doesNotMatch(JSON.stringify(up), /203\.0\.113|backup\.example/);
  primary = 200;
  const alone = new HubClient("hypersnape.node", [{ url: `http://${IP}:3381`, headers: {} }], 1000, { displayName: "hypersnape.node", fetchImpl: fakeFetch({ [`${IP}:3381`]: () => res(503) }) });
  const down = await alone.info();
  assert.equal(down.reachable, false);
  assert.match(down.error ?? "", /^hypersnape\.node: the provider is having a bad day \(HTTP 503\)/);
  assert.doesNotMatch(JSON.stringify(down), /203\.0\.113/);
  // Without displayName nothing changes: hosts are shown as before.
  const open = new HubClient("x", [{ url: `http://${IP}:3381`, headers: {} }], 1000, { fetchImpl: fakeFetch({ [`${IP}:3381`]: () => res(200, INFO) }) });
  assert.equal((await open.info()).provider, `${IP}:3381`);
});

test("dashboard: a private node's card shows its label where a public node's shows its host", async () => {
  const node = (label: string, network: string, url: string, priv: boolean) => ({ label, url, network, headers: {}, providers: [{ url, headers: {} }], ...(priv ? { private: true } : {}) });
  const cfg = { ...loadConfig(), nodes: [node("snapchain", "snapchain", "https://sc.example", false), node("hypersnape.node", "hypersnap", `http://${IP}:3381`, true)], reference: "snapchain" };
  const store = new SqliteStore(":memory:");
  const html = await (await buildApp(cfg, store).request("http://x/")).text();
  const llms = await (await buildApp(cfg, store).request("http://x/llms.txt")).text();
  await store.close();
  assert.match(html, /sc\.example/);
  assert.match(html, /hypersnape\.node/);
  assert.doesNotMatch(html, /203\.0\.113/);
  assert.doesNotMatch(llms, /203\.0\.113/);
});
