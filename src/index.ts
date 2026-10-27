import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { HubClient } from "./hub.js";
import { every, pollInfo, recheckOnce, scanOnce, type Deps } from "./loops.js";
import { buildApp } from "./server.js";
import { SqliteStore } from "./store/sqlite.js";
import type { Store } from "./store/store.js";

const cfg = loadConfig();
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

// The only line to change when moving to SpacetimeDB (see src/store/spacetime.ts).
const store: Store = new SqliteStore(cfg.dbPath);

const deps: Deps = {
  cfg,
  store,
  log,
  hubs: {
    a: new HubClient("a", cfg.a.url, cfg.requestTimeoutMs, cfg.a.headers),
    b: new HubClient("b", cfg.b.url, cfg.requestTimeoutMs, cfg.b.headers),
  },
};

log(`snapdiff: ${cfg.a.label} (${cfg.a.url}) vs ${cfg.b.label} (${cfg.b.url})`);
log(`watchlist: ${cfg.watchFids.length} fids, +${cfg.sampleSize} random per scan, lookback ${cfg.lookbackHours}h`);

// Info first so FID sampling has an upper bound before the first scan.
await pollInfo(deps).catch((e: unknown) => log(`[info] ${String(e)}`));

const stops = [
  every(cfg.infoIntervalMs, "info", () => pollInfo(deps), log),
  every(cfg.scanIntervalMs, "scan", () => scanOnce(deps), log),
  every(cfg.recheckIntervalMs, "recheck", () => recheckOnce(deps), log),
];

const server = serve({ fetch: buildApp(cfg, store).fetch, port: cfg.port, hostname: "0.0.0.0" });
log(`dashboard: http://localhost:${cfg.port}`);

const shutdown = async () => {
  for (const s of stops) s();
  server.close();
  await store.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
