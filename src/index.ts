import { serve } from "@hono/node-server";
import { ClientHealthMonitor, loadClients } from "./clients.js";
import { loadConfig } from "./config.js";
import { HubClient } from "./hub.js";
import { every, pollInfo, recheckOnce, scanOnce, type Deps } from "./loops.js";
import { ReleaseMonitor } from "./releases.js";
import { TestnetFeed } from "./testnet-feed.js";
import { isTestnetNetwork } from "./config.js";
import { buildApp } from "./server.js";
import { SqliteStore } from "./store/sqlite.js";
import type { Store } from "./store/store.js";

const cfg = loadConfig();
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

// The only line to change when moving to SpacetimeDB (see src/store/spacetime.ts).
// The legacy labels tell a two-node database what its 'a'/'b' rows meant (first and second node).
const store: Store = new SqliteStore(cfg.dbPath, {
  legacy: { a: cfg.nodes[0]!.label, b: cfg.nodes[1]!.label },
  networks: Object.fromEntries(cfg.nodes.map((n) => [n.label, n.network])),
});

const deps: Deps = {
  cfg,
  store,
  log,
  hubs: Object.fromEntries(cfg.nodes.map((n) => [n.label, new HubClient(n.label, n.providers, cfg.requestTimeoutMs, { providerRetryMs: cfg.providerRetryMs, ...(n.private ? { displayName: n.label } : {}) })])),
};

log(`snapdiff: reference ${cfg.reference}; nodes ${cfg.nodes.map((n) => `${n.label} [${n.network}] (${n.private ? "private" : n.providers.map((p) => p.url).join(" -> ")})`).join(", ")}`);
log(`watchlist: ${cfg.watchFids.length} fids, +${cfg.sampleSize} random per scan, lookback ${cfg.lookbackHours}h`);

// Info first so FID sampling has an upper bound before the first scan.
await pollInfo(deps).catch((e: unknown) => log(`[info] ${String(e)}`));

// Data shard count per node, from its latest /v1/info (for the testnet feed's shard list).
const infoShards = new Map<string, number>();
const refreshShards = async () => {
  for (const n of cfg.nodes) {
    const i = await store.latestInfo(n.label);
    if (i?.numShards) infoShards.set(n.label, i.numShards);
  }
};
await refreshShards();

const stops = [
  every(cfg.infoIntervalMs, "info", () => pollInfo(deps).then(refreshShards), log),
  every(cfg.scanIntervalMs, "scan", () => scanOnce(deps), log),
  every(cfg.recheckIntervalMs, "recheck", () => recheckOnce(deps), log),
];

// Client health is off unless CLIENT_HEALTH_FILE names a config (docs/CLIENT-HEALTH.md).
// A bad config file is a startup error on purpose: a silently empty card would hide a typo.
const clientSpecs = cfg.clientHealthFile === "" ? [] : loadClients(cfg.clientHealthFile);
const monitor = clientSpecs.length > 0 ? new ClientHealthMonitor(clientSpecs, fetch, log) : null;
if (monitor) {
  log(`clients: ${clientSpecs.length} configured, checked every ${Math.round(cfg.clientHealthIntervalMs / 1000)}s`);
  await monitor.runAll().catch((e: unknown) => log(`[clients] ${String(e)}`));
  stops.push(every(cfg.clientHealthIntervalMs, "clients", () => monitor.runAll(), log));
}

// Published releases (src/releases.ts): one Docker Hub tag-list fetch per network per
// RELEASE_INTERVAL_MIN, from this host. Off when no network has a feed (RELEASE_FEED_*=off).
const releaseNets = Object.keys(cfg.releaseFeeds);
const releases = releaseNets.length > 0 ? new ReleaseMonitor(cfg.releaseFeeds, fetch, log) : null;
if (releases) {
  log(`releases: watching ${releaseNets.join(", ")} every ${Math.round(cfg.releaseIntervalMs / 60_000)} min`);
  await releases.runAll().catch((e: unknown) => log(`[releases] ${String(e)}`));
  stops.push(every(cfg.releaseIntervalMs, "releases", () => releases.runAll(), log));
}

// Testnet cast explorer (src/testnet-feed.ts): one feed per testnet network, read from that
// network's reference node; data shard ids come from the node's latest /v1/info.
const testnetNets = Object.entries(cfg.references).filter(([network]) => isTestnetNetwork(network));
const feed =
  testnetNets.length > 0
    ? new TestnetFeed(
        Object.fromEntries(
          testnetNets.map(([network, source]) => [
            network,
            {
              hub: deps.hubs[source]!,
              source,
              shards: () => {
                const n = infoShards.get(source);
                return n !== undefined && n > 0 ? Array.from({ length: n }, (_, i) => i + 1) : [1, 2];
              },
            },
          ]),
        ),
        log,
      )
    : null;
if (feed) {
  log(`testnet feed: ${testnetNets.map(([n, s]) => `${n} via ${s}`).join(", ")}, every ${Math.round(cfg.testnetFeedIntervalMs / 1000)}s`);
  stops.push(every(cfg.testnetFeedIntervalMs, "testnet-feed", () => feed.runAll(), log));
}

const server = serve({ fetch: buildApp(cfg, store, monitor ? () => monitor.snapshot() : undefined, releases ? () => releases.snapshot() : undefined, feed ? () => feed.snapshot() : undefined).fetch, port: cfg.port, hostname: "0.0.0.0" });
log(`dashboard: http://localhost:${cfg.port}`);

const shutdown = async () => {
  for (const s of stops) s();
  server.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
