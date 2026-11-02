import { serve } from "@hono/node-server";
import { ClientHealthMonitor, loadClients } from "./clients.js";
import { loadConfig } from "./config.js";
import { HubClient } from "./hub.js";
import { every, pollInfo, recheckOnce, scanOnce, type Deps } from "./loops.js";
import { buildApp } from "./server.js";
import { SqliteStore } from "./store/sqlite.js";
import type { Store } from "./store/store.js";

const cfg = loadConfig();
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

// The only line to change when moving to SpacetimeDB (see src/store/spacetime.ts).
// The legacy labels tell a two-node database what its 'a'/'b' rows meant (first and second node).
const store: Store = new SqliteStore(cfg.dbPath, { a: cfg.nodes[0]!.label, b: cfg.nodes[1]!.label });

const deps: Deps = {
  cfg,
  store,
  log,
  hubs: Object.fromEntries(cfg.nodes.map((n) => [n.label, new HubClient(n.label, n.url, cfg.requestTimeoutMs, n.headers)])),
};

log(`snapdiff: reference ${cfg.reference}; nodes ${cfg.nodes.map((n) => `${n.label} (${n.url})`).join(", ")}`);
log(`watchlist: ${cfg.watchFids.length} fids, +${cfg.sampleSize} random per scan, lookback ${cfg.lookbackHours}h`);

// Info first so FID sampling has an upper bound before the first scan.
await pollInfo(deps).catch((e: unknown) => log(`[info] ${String(e)}`));

const stops = [
  every(cfg.infoIntervalMs, "info", () => pollInfo(deps), log),
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

const server = serve({ fetch: buildApp(cfg, store, monitor ? () => monitor.snapshot() : undefined).fetch, port: cfg.port, hostname: "0.0.0.0" });
log(`dashboard: http://localhost:${cfg.port}`);

const shutdown = async () => {
  for (const s of stops) s();
  server.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
