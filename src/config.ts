import { readFileSync, existsSync } from "node:fs";

export interface Provider {
  url: string;
  /** Extra request headers, for hosted nodes that need a key (Neynar: x-api-key). */
  headers: Record<string, string>;
}

export interface NodeConfig {
  label: string;
  /** Primary provider's URL (providers[0]); kept for display and older call sites. */
  url: string;
  /** Which protocol network the node follows ("snapchain", "hypersnap"). Diff scope is judged per network. */
  network: string;
  /** Primary provider's headers (providers[0]). */
  headers: Record<string, string>;
  /**
   * Ways to reach this one logical node, tried in order. A hosted endpoint that runs out of
   * credits or rate-limits is benched and the next provider answers; same network, same data.
   */
  providers: Provider[];
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
  /** A benched provider (out of credits, bad key, rate limited, unreachable) is retried after this long. */
  providerRetryMs: number;
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

/** A label that names its network needs no NODE_<LABEL>_NETWORK. */
export const inferNetwork = (label: string): string | undefined => {
  const l = label.toLowerCase();
  if (l.includes("snapchain")) return "snapchain";
  if (l.includes("hypersnap")) return "hypersnap";
  return undefined;
};

/**
 * Nodes come from NODES="label,label,..." with NODE_<LABEL>_URL / NODE_<LABEL>_NETWORK /
 * NODE_<LABEL>_HEADERS per label, or, when NODES is unset, from the original two-node
 * NODE_A_* / NODE_B_* variables (networks default to snapchain for A and hypersnap for B).
 * REFERENCE_NODE picks the node that anchors the dashboard and presentOn (default: the first).
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
  // Fallback providers: NODE_<K>_URL_2 / NODE_<K>_HEADERS_2, _3, ... in order, no gaps.
  const providersFor = (prefix: string, primary: Provider): Provider[] => {
    const out = [primary];
    for (let i = 2; ; i++) {
      const url = read(`${prefix}_URL_${i}`, "");
      if (url === "") break;
      out.push({ url: url.replace(/\/$/, ""), headers: headers(`${prefix}_HEADERS_${i}`) });
    }
    return out;
  };
  const withProviders = (label: string, network: string, prefix: string, primaryUrl: string): NodeConfig => {
    const providers = providersFor(prefix, { url: primaryUrl.replace(/\/$/, ""), headers: headers(`${prefix}_HEADERS`) });
    return { label, url: providers[0]!.url, network, headers: providers[0]!.headers, providers };
  };
  const legacy = (slot: "A" | "B", label: string, url: string, network: string): NodeConfig => {
    const l = read(`NODE_${slot}_LABEL`, label);
    return withProviders(l, read(`NODE_${slot}_NETWORK`, inferNetwork(l) ?? network), `NODE_${slot}`, read(`NODE_${slot}_URL`, url));
  };
  const nodes: NodeConfig[] =
    listed.length === 0
      ? [legacy("A", "snapchain", "http://127.0.0.1:3381", "snapchain"), legacy("B", "hypersnap", "http://127.0.0.1:4381", "hypersnap")]
      : listed.map((label) => {
          const k = envKeyFor(label);
          const url = read(`NODE_${k}_URL`, "");
          if (url === "") throw new Error(`NODES lists "${label}" but NODE_${k}_URL is not set`);
          const network = read(`NODE_${k}_NETWORK`, inferNetwork(label) ?? "");
          if (network === "") throw new Error(`NODE_${k}_NETWORK is not set and "${label}" does not name its network (snapchain or hypersnap)`);
          return withProviders(label, network, `NODE_${k}`, url);
        });
  if (nodes.length < 2) throw new Error("at least two nodes are required");
  const seen = new Set<string>();
  for (const n of nodes) {
    if (!LABEL_RE.test(n.label)) throw new Error(`node label "${n.label}" must be 1 to 24 letters, digits, or dashes`);
    if (!LABEL_RE.test(n.network)) throw new Error(`network "${n.network}" for node "${n.label}" must be 1 to 24 letters, digits, or dashes`);
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
    providerRetryMs: num("PROVIDER_RETRY_MIN", 10) * min,
    clientHealthFile: str("CLIENT_HEALTH_FILE", ""),
    clientHealthIntervalMs: num("CLIENT_HEALTH_INTERVAL_SEC", 60) * 1000,
  };
}

/** Every node except the reference, in config order. */
export const comparedNodes = (cfg: Pick<Config, "nodes" | "reference">): NodeConfig[] => cfg.nodes.filter((n) => n.label !== cfg.reference);

/** Networks in first-seen config order, each with the labels of its nodes. */
export function networks(cfg: Pick<Config, "nodes">): Array<{ network: string; labels: string[] }> {
  const out: Array<{ network: string; labels: string[] }> = [];
  for (const n of cfg.nodes) {
    const e = out.find((x) => x.network === n.network);
    if (e === undefined) out.push({ network: n.network, labels: [n.label] });
    else e.labels.push(n.label);
  }
  return out;
}
