import { readFileSync, existsSync } from "node:fs";

export interface NodeConfig {
  label: string;
  url: string;
  /** Extra request headers, for hosted nodes that need a key (Neynar: x-api-key). */
  headers: Record<string, string>;
}

const headersFrom = (name: string): Record<string, string> => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object like {"x-api-key":"..."}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object`);
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
};

export interface Config {
  a: NodeConfig;
  b: NodeConfig;
  dbPath: string;
  port: number;
  /** FIDs always scanned: your watchlist (for example, accounts that declined the contract). */
  watchFids: number[];
  /** Random FIDs added to each scan, for a baseline. */
  sampleSize: number;
  /** Override for the random-FID upper bound. 0 means use dbStats from the nodes. */
  maxFid: number;
  infoIntervalMs: number;
  scanIntervalMs: number;
  recheckIntervalMs: number;
  /** Wait this long after first seeing a diff before rechecking it. */
  recheckAfterMs: number;
  /** A diff still missing after this long is classified unexplained. */
  unexplainedAfterMs: number;
  /** Stop rechecking diffs older than this. */
  recheckWindowMs: number;
  /** Only compare casts from the last N hours. */
  lookbackHours: number;
  /** Ignore casts newer than this; they may still be propagating. */
  graceSeconds: number;
  /** A side whose worst blockDelay exceeds this is "behind"; its diffs stay pending. */
  behindBlockDelay: number;
  /** Cast text above this many UTF-8 bytes depends on V21 rules. */
  v21TextBytes: number;
  /**
   * Message types the relay does not carry between the networks (for example channel message
   * types). A diff of one of these types is relay_filtered, not unexplained. Empty until the
   * relay ships and the exact type names are known.
   */
  relayFilteredTypes: Set<string>;
  /**
   * When true, a diff whose FID has no ID registration on the missing node is relay_filtered:
   * FIDs registered on one network only (Hypersnap "on network" FIDs) never replicate.
   */
  fidOriginCheck: boolean;
  concurrency: number;
  maxPagesPerFid: number;
  requestTimeoutMs: number;
}

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
};

const str = (name: string, fallback: string): string => {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
};

export const parseFidList = (text: string): number[] =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("#"))
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

export function loadConfig(): Config {
  const watch = new Set<number>(parseFidList(str("WATCH_FIDS", "")));
  const file = str("WATCH_FIDS_FILE", "");
  if (file !== "") {
    if (!existsSync(file)) throw new Error(`WATCH_FIDS_FILE not found: ${file}`);
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, ""))
      .join("\n");
    for (const f of parseFidList(lines)) watch.add(f);
  }

  const min = 60_000;
  return {
    a: {
      label: str("NODE_A_LABEL", "snapchain"),
      url: str("NODE_A_URL", "http://127.0.0.1:3381").replace(/\/$/, ""),
      headers: headersFrom("NODE_A_HEADERS"),
    },
    b: {
      label: str("NODE_B_LABEL", "hypersnap"),
      url: str("NODE_B_URL", "http://127.0.0.1:4381").replace(/\/$/, ""),
      headers: headersFrom("NODE_B_HEADERS"),
    },
    dbPath: str("DB_PATH", "./data/snapdiff.db"),
    port: num("PORT", 8787),
    watchFids: [...watch].sort((x, y) => x - y),
    sampleSize: num("SAMPLE_SIZE", 50),
    maxFid: num("MAX_FID", 0),
    infoIntervalMs: num("INFO_INTERVAL_SEC", 60) * 1000,
    scanIntervalMs: num("SCAN_INTERVAL_MIN", 15) * min,
    recheckIntervalMs: num("RECHECK_INTERVAL_SEC", 60) * 1000,
    recheckAfterMs: num("RECHECK_AFTER_MIN", 5) * min,
    unexplainedAfterMs: num("UNEXPLAINED_AFTER_MIN", 30) * min,
    recheckWindowMs: num("RECHECK_WINDOW_HOURS", 24) * 60 * min,
    lookbackHours: num("LOOKBACK_HOURS", 24),
    graceSeconds: num("GRACE_SEC", 60),
    behindBlockDelay: num("BEHIND_BLOCK_DELAY", 50),
    v21TextBytes: num("V21_TEXT_BYTES", 1024),
    relayFilteredTypes: new Set(
      str("RELAY_FILTERED_TYPES", "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
    fidOriginCheck: str("FID_ORIGIN_CHECK", "1") !== "0",
    concurrency: num("CONCURRENCY", 4),
    maxPagesPerFid: num("MAX_PAGES_PER_FID", 20),
    requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 10_000),
  };
}

export const labelOf = (cfg: Pick<Config, "a" | "b">, side: "a" | "b"): string =>
  side === "a" ? cfg.a.label : cfg.b.label;
