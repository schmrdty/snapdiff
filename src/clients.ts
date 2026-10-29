// Client health: optional status checks for the APPS people use on each
// network (Vibeshift, Quilcast, Quorum, and the like), shown beside the node
// cards with a link to each client's site.
//
// Safety contract (docs/CLIENT-HEALTH.md):
//   * every URL comes from the operator's config file, never from a response;
//   * HTTPS only, redirects refused, 5 s timeout, body capped at 16 KB;
//   * the response is reduced to a status word from a fixed set and a short
//     note; the raw body is never stored or rendered;
//   * links on the page are the configured siteUrl, rendered with
//     rel="noopener noreferrer".
import { readFileSync } from "node:fs";

export type ClientNetwork = "snapchain" | "hypersnap" | "both";
export const CLIENT_NETWORKS: readonly ClientNetwork[] = ["snapchain", "hypersnap", "both"];

export type ClientStatus = "ok" | "degraded" | "down" | "unknown";
export const CLIENT_STATUSES: readonly ClientStatus[] = ["ok", "degraded", "down", "unknown"];

export interface ClientSpec {
  /** Display name, 1 to 40 printable characters. */
  label: string;
  network: ClientNetwork;
  /** Where the link goes. HTTPS only. */
  siteUrl: string;
  /** Optional health endpoint. HTTPS only. Absent = link only, status stays unknown. */
  healthUrl?: string;
  /** Dot path to the status field in the JSON body (default "status"); null = any HTTP 200 is ok. */
  statusPath?: string | null;
  /** Values at statusPath that mean ok (case-insensitive). */
  okValues?: string[];
}

export interface ClientHealth {
  label: string;
  network: ClientNetwork;
  siteUrl: string;
  siteHost: string;
  healthUrl: string | null;
  status: ClientStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  checkedAt: number | null;
  /** Short, operator-readable reason. Built from fixed phrases plus at most 40 chars of a status value. */
  note: string;
}

export const DEFAULT_OK_VALUES: readonly string[] = ["ok", "healthy", "up", "operational", "pass", "green"];
export const HEALTH_TIMEOUT_MS = 5000;
export const HEALTH_MAX_BODY = 16 * 1024;
const LABEL_MAX = 40;
const PATH_MAX_DEPTH = 6;

const isHttpsUrl = (s: unknown): s is string => {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.username === "" && u.password === "";
  } catch {
    return false;
  }
};

const isLabel = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 1 && s.length <= LABEL_MAX && /^[\x20-\x7e]+$/.test(s);

/** Parse and validate the clients config. Throws with the reason; a bad entry rejects the whole file. */
export function parseClients(json: string): ClientSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("clients config is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("clients config must be a JSON array");
  const out: ClientSpec[] = [];
  const seen = new Set<string>();
  parsed.forEach((raw, i) => {
    const where = `clients[${i}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${where}: must be an object`);
    const c = raw as Record<string, unknown>;
    if (!isLabel(c.label)) throw new Error(`${where}: label must be 1 to ${LABEL_MAX} printable ASCII characters`);
    if (seen.has(c.label)) throw new Error(`${where}: duplicate label "${c.label}"`);
    seen.add(c.label);
    if (!CLIENT_NETWORKS.includes(c.network as ClientNetwork)) throw new Error(`${where}: network must be one of ${CLIENT_NETWORKS.join(", ")}`);
    if (!isHttpsUrl(c.siteUrl)) throw new Error(`${where}: siteUrl must be an https URL with no credentials`);
    if (c.healthUrl !== undefined && !isHttpsUrl(c.healthUrl)) throw new Error(`${where}: healthUrl must be an https URL with no credentials`);
    if (c.statusPath !== undefined && c.statusPath !== null) {
      if (typeof c.statusPath !== "string" || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+){0,5}$/.test(c.statusPath)) {
        throw new Error(`${where}: statusPath must be a dot path of identifiers (at most ${PATH_MAX_DEPTH} deep) or null`);
      }
    }
    if (c.okValues !== undefined) {
      if (!Array.isArray(c.okValues) || !c.okValues.every((v) => typeof v === "string" && v.length > 0 && v.length <= LABEL_MAX)) {
        throw new Error(`${where}: okValues must be an array of short strings`);
      }
    }
    const spec: ClientSpec = { label: c.label, network: c.network as ClientNetwork, siteUrl: c.siteUrl };
    if (c.healthUrl !== undefined) spec.healthUrl = c.healthUrl;
    if (c.statusPath !== undefined) spec.statusPath = c.statusPath as string | null;
    if (c.okValues !== undefined) spec.okValues = c.okValues as string[];
    out.push(spec);
  });
  return out;
}

export function loadClients(path: string): ClientSpec[] {
  return parseClients(readFileSync(path, "utf8"));
}

const dig = (obj: unknown, path: string): unknown => {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const unknownFor = (c: ClientSpec, note: string): ClientHealth => ({
  label: c.label,
  network: c.network,
  siteUrl: c.siteUrl,
  siteHost: new URL(c.siteUrl).host,
  healthUrl: c.healthUrl ?? null,
  status: "unknown",
  httpStatus: null,
  latencyMs: null,
  checkedAt: null,
  note,
});

/** One check. Never throws; every failure mode becomes a status word and a fixed-phrase note. */
export async function checkClient(c: ClientSpec, fetchFn: FetchLike = fetch, now: () => number = Date.now): Promise<ClientHealth> {
  if (!c.healthUrl) return unknownFor(c, "no health endpoint configured");
  const base = { ...unknownFor(c, ""), checkedAt: now() };
  const t0 = now();
  let res: Response;
  try {
    res = await fetchFn(c.healthUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      headers: { accept: "application/json, text/plain;q=0.5" },
    });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const msg = e instanceof Error ? e.message : "";
    const note = name === "TimeoutError" || name === "AbortError" ? "timeout" : /redirect/i.test(msg) ? "redirect refused" : "unreachable";
    return { ...base, status: "down", latencyMs: now() - t0, note };
  }
  const latencyMs = now() - t0;
  const withRes = { ...base, httpStatus: res.status, latencyMs };
  if (!res.ok) return { ...withRes, status: "down", note: `HTTP ${res.status}` };
  if (c.statusPath === null) return { ...withRes, status: "ok", note: "HTTP 200" };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ...withRes, status: "unknown", note: "unreadable body" };
  }
  if (text.length > HEALTH_MAX_BODY) return { ...withRes, status: "unknown", note: "body too large" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ...withRes, status: "unknown", note: "not JSON" };
  }
  const value = dig(body, c.statusPath ?? "status");
  const okValues = (c.okValues ?? DEFAULT_OK_VALUES).map((v) => v.toLowerCase());
  if (typeof value === "boolean") return { ...withRes, status: value ? "ok" : "degraded", note: `status ${value}` };
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return okValues.includes(v) ? { ...withRes, status: "ok", note: "" } : { ...withRes, status: "degraded", note: `status "${value.slice(0, 40)}"` };
  }
  return { ...withRes, status: "unknown", note: "no status field" };
}

/** Holds the latest result per client in memory; the dashboard reads a snapshot. */
export class ClientHealthMonitor {
  private latest = new Map<string, ClientHealth>();

  constructor(
    private readonly specs: ClientSpec[],
    private readonly fetchFn: FetchLike = fetch,
    private readonly log: (m: string) => void = () => {},
  ) {
    for (const s of specs) this.latest.set(s.label, unknownFor(s, "not checked yet"));
  }

  async runAll(concurrency = 2): Promise<void> {
    const queue = [...this.specs];
    const worker = async () => {
      for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
        const r = await checkClient(c, this.fetchFn);
        const prev = this.latest.get(c.label);
        if (prev && prev.status !== r.status) this.log(`[clients] ${c.label}: ${prev.status} -> ${r.status}${r.note ? ` (${r.note})` : ""}`);
        this.latest.set(c.label, r);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }

  snapshot(): ClientHealth[] {
    return this.specs.map((s) => this.latest.get(s.label)).filter((v): v is ClientHealth => v !== undefined);
  }
}
