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
  /** Two or more nodes. Labels are unique and double as the node id in the database. */
  nodes: NodeConfig[];
  /** Label of the node every other node is compared against. */
  reference: string;
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
  /** Path to the clients JSON (docs/CLIENT-HEALTH.md). Empty = feature off. */
  clientHealthFile: string;
  clientHealthIntervalMs: number;
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

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,23}$/;
/** "ohsnap" -> NODE_OHSNAP_URL; "open-caster" -> NODE_OPEN_CASTER_URL. */
export const envKeyFor = (label: string): string => label.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/**
 * Nodes come from NODES="label,label,..." with NODE_<LABEL>_URL / NODE_<LABEL>_HEADERS per
 * label, or, when NODES is unset, from the original two-node NODE_A_* / NODE_B_* variables.
 * REFERENCE_NODE picks the node the others are compared against (default: the first).
 */
export function loadNodes(env: NodeJS.ProcessEnv = process.env): { nodes: NodeConfig[]; reference: string } {
  const read = (name: string, fallback: string): string => {
    const raw = env[name];
    return raw === undefined || raw === "" ? fallback : raw;
  };
  const headers = (name: string): Record<string, string> => {
    const saved = process.env[name];
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return {};
    // headersFrom reads process.env; route through it so the one JSON parser is shared.
    process.env[name] = raw;
    try {
      return headersFrom(name);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  };
  const listed = read("NODES", "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const nodes: NodeConfig[] =
    listed.length === 0
      ? [
          { label: read("NODE_A_LABEL", "snapchain"), url: read("NODE_A_URL", "http://127.0.0.1:3381").replace(/\/$/, ""), headers: headers("NODE_A_HEADERS") },
          { label: read("NODE_B_LABEL", "hypersnap"), url: read("NODE_B_URL", "http://127.0.0.1:4381").replace(/\/$/, ""), headers: headers("NODE_B_HEADERS") },
        ]
      : listed.map((label) => {
          const k = envKeyFor(label);
          const url = read(`NODE_${k}_URL`, "");
          if (url === "") throw new Error(`NODES lists "${label}" but NODE_${k}_URL is not set`);
          return { label, url: url.replace(/\/$/, ""), headers: headers(`NODE_${k}_HEADERS`) };
        });
  if (nodes.length < 2) throw new Error("at least two nodes are required");
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!LABEL_RE.test(n.label)) throw new Error(`node label "${n.label}" must be 1 to 24 letters, digits, or dashes`);
    if (seen.has(n.label)) throw new Error(`duplicate node label "${n.label}"`);
    seen.add(n.label);
  }
  const reference = read("REFERENCE_NODE", nodes[0]!.label);
  if (!seen.has(reference)) throw new Error(`REFERENCE_NODE "${reference}" is not one of: ${nodes.map((n) => n.label).join(", ")}`);
  return { nodes, reference };
}

export const nodeOf = (cfg: Pick<Config, "nodes">, label: string): NodeConfig | undefined => cfg.nodes.find((n) => n.label === label);

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
  const { nodes, reference } = loadNodes();
  return {
    nodes,
    reference,
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
    clientHealthFile: str("CLIENT_HEALTH_FILE", ""),
    clientHealthIntervalMs: num("CLIENT_HEALTH_INTERVAL_SEC", 60) * 1000,
  };
}

/** Every node except the reference, in config order. */
export const comparedNodes = (cfg: Pick<Config, "nodes" | "reference">): NodeConfig[] => cfg.nodes.filter((n) => n.label !== cfg.reference);
