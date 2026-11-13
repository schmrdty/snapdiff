import type { Provider } from "./config.js";
import type { HubMessage, InfoSnapshot, ShardInfo, Side } from "./types.js";
import { FIRST_NATIVE_FID } from "./shard.js";

/** Farcaster epoch: 2021-01-01T00:00:00Z, in unix seconds. */
export const FARCASTER_EPOCH = 1_609_459_200;
export const toUnixSec = (fcTs: number): number => fcTs + FARCASTER_EPOCH;
export const toFarcasterSec = (unixSec: number): number => Math.max(0, unixSec - FARCASTER_EPOCH);

export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** Statuses that mean "this provider will keep refusing us", so the next provider should answer. */
const BENCH_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 429]);

/** Short, honest, no account details. The status code stays so an operator can look it up. */
export function explainStatus(status: number | null, timeoutMs: number): string {
  if (status === 402) return "out of credits: the hosted provider wants to be paid before it answers (HTTP 402)";
  if (status === 401 || status === 403) return `the provider turned our key away (HTTP ${status})`;
  if (status === 429) return "the provider asked us to slow down (HTTP 429)";
  if (status !== null && status >= 500) return `the provider is having a bad day (HTTP ${status})`;
  if (status !== null) return `unexpected answer (HTTP ${status})`;
  return `no answer within ${Math.round(timeoutMs / 1000)}s`;
}

export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Whether an error response means "definitely absent" rather than "something went wrong".
 * Upstream Snapchain answers `{ errCode: "not_found..." }`; Hypersnap's HTTP wrapper answers
 * HTTP 400 with `error_detail: "status: NotFound, message: \"cast not found\" ..."`. Both count.
 * A validation error (bad fid, bad hash) matches neither and stays an error.
 */
export function isNotFound(status: number, body: unknown): boolean {
  if (status === 404) return true;
  if (typeof body !== "object" || body === null) return false;
  const b = body as { errCode?: unknown; error_detail?: unknown; details?: unknown };
  if (typeof b.errCode === "string" && b.errCode.startsWith("not_found")) return true;
  const detail = [b.error_detail, b.details].filter((v): v is string => typeof v === "string").join(" ");
  return /\bNotFound\b|\bnot found\b/i.test(detail);
}

/**
 * FIDs arrive as JSON numbers for legacy accounts and as decimal strings for native accounts
 * (>= 2^32; Hypersnap emits those as strings so JavaScript clients do not round them). Both
 * become a number here. Null for anything else, or past 2^53 (native FIDs count up from 2^32,
 * so that limit is not a concern for a very long time).
 */
export function normalizeFid(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d{1,16}$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Message types `route_message` sends to `shardForFid(data.fid)`. Everything else is shard-0 state. */
export const FID_HASH_ROUTED_TYPES: ReadonlySet<string> = new Set([
  "MESSAGE_TYPE_CAST_ADD",
  "MESSAGE_TYPE_CAST_REMOVE",
  "MESSAGE_TYPE_REACTION_ADD",
  "MESSAGE_TYPE_REACTION_REMOVE",
  "MESSAGE_TYPE_LINK_ADD",
  "MESSAGE_TYPE_LINK_REMOVE",
  "MESSAGE_TYPE_LINK_COMPACT_STATE",
  "MESSAGE_TYPE_USER_DATA_ADD",
  "MESSAGE_TYPE_USERNAME_PROOF",
  "MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS",
  "MESSAGE_TYPE_VERIFICATION_REMOVE",
  "MESSAGE_TYPE_FRAME_ACTION",
]);

/**
 * Minimal read-only client for the Snapchain HTTP API (port 3381).
 * Hypersnap is a Snapchain fork and is assumed to serve the same endpoints.
 * Run `npm run check-nodes` to confirm before trusting results.
 */
export interface HubOptions {
  /** How long a benched provider stays benched before it is tried again. */
  providerRetryMs?: number;
  /**
   * Set for a private node: snapshots, notes, and error texts then name providers by this
   * (the label, plus "(provider N)" for a fallback) instead of by host, so the host never
   * reaches the dashboard, the API, or the database.
   */
  displayName?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class HubClient {
  readonly providers: ReadonlyArray<Provider>;
  private readonly providerRetryMs: number;
  private readonly displayName: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Index of the provider that answered last. */
  private active = 0;
  /** Provider index -> time until which it is benched, with the reason. */
  private readonly benched = new Map<number, { until: number; why: string; refused: boolean }>();

  constructor(
    readonly side: Side,
    providers: ReadonlyArray<Provider> | string,
    private readonly timeoutMs: number,
    opts: HubOptions = {},
  ) {
    this.providers = typeof providers === "string" ? [{ url: providers, headers: {} }] : providers;
    if (this.providers.length === 0) throw new Error(`node "${side}" has no providers`);
    this.providerRetryMs = opts.providerRetryMs ?? 10 * 60_000;
    this.displayName = opts.displayName;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Primary provider's URL; what the config says, not necessarily who is answering. */
  get baseUrl(): string {
    return this.providers[0]!.url;
  }

  /** URL of the provider that answered most recently. */
  get activeUrl(): string {
    return this.providers[this.active]!.url;
  }

  /** How provider i is named in anything that leaves this class: its host, or the private node's label. */
  private nameOf(i: number): string {
    if (this.displayName === undefined) return hostOf(this.providers[i]!.url);
    return i === 0 ? this.displayName : `${this.displayName} (provider ${i + 1})`;
  }

  /** Why the primary is not answering, when a fallback is. Null when the primary is fine. */
  primaryNote(): string | null {
    const b = this.benched.get(0);
    if (b === undefined || this.active === 0) return null;
    return `${this.nameOf(0)}: ${b.why}; answering via ${this.nameOf(this.active)}`;
  }

  private async fetchOnce(p: Provider, path: string): Promise<{ status: number; body: unknown }> {
    // Some hosted nodes (Neynar) return 403 to Node's default User-Agent. Always identify.
    const headers = { "user-agent": "snapdiff/0.5 (+read-only comparator)", ...p.headers };
    let res = await this.fetchImpl(`${p.url}${path}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    // Hosted nodes rate-limit. Back off briefly before giving up.
    for (const waitMs of [1000, 3000]) {
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, waitMs));
      res = await this.fetchImpl(`${p.url}${path}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  /**
   * Try the active provider, then the others in order. A provider that refuses us (401, 402,
   * 403, 429 after backoff) or does not answer is benched for providerRetryMs; a benched
   * provider is skipped until then, so one dead key does not slow every request. A 4xx/5xx
   * that is not a refusal (not found, bad request) is a normal answer and is returned as-is.
   */
  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const now = this.now();
    const order = [this.active, ...this.providers.map((_, i) => i).filter((i) => i !== this.active)];
    const isBenched = (i: number): boolean => {
      const b = this.benched.get(i);
      return b !== undefined && now < b.until;
    };
    let tryOrder = order.filter((i) => !isBenched(i));
    // Nobody is live. A provider benched for silence (a timeout, a network error) is tried
    // anyway: otherwise one slow answer reports the node down for providerRetryMs without a
    // single new request, which is what ohsnap showed on 2026-11-11 (one 10 s miss, ten
    // minutes of "no answer"). A refusal (401, 402, 403, 429) stays benched: asking again
    // changes nothing and costs a paid request.
    if (tryOrder.length === 0) tryOrder = order.filter((i) => this.benched.get(i)?.refused === false);
    let lastError: HubError | null = null;
    for (const i of tryOrder) {
      const p = this.providers[i]!;
      try {
        const r = await this.fetchOnce(p, path);
        if (BENCH_STATUSES.has(r.status)) {
          const why = explainStatus(r.status, this.timeoutMs);
          this.benched.set(i, { until: now + this.providerRetryMs, why, refused: true });
          lastError = new HubError(`${this.nameOf(i)}: ${why}`, r.status);
          continue;
        }
        this.benched.delete(i);
        this.active = i;
        return r;
      } catch (e) {
        const why = e instanceof HubError ? e.message : explainStatus(null, this.timeoutMs);
        this.benched.set(i, { until: now + this.providerRetryMs, why, refused: false });
        lastError = new HubError(`${this.nameOf(i)}: ${why}`, null);
      }
    }
    // Everyone is benched. Report the primary's reason; it is the one the operator configured.
    const primary = this.benched.get(0);
    throw lastError ?? new HubError(primary ? `${this.nameOf(0)}: ${primary.why}` : "no provider answered", null);
  }

  async info(): Promise<InfoSnapshot> {
    const at = Date.now();
    try {
      const { status, body } = await this.get("/v1/info");
      if (status !== 200 || typeof body !== "object" || body === null) {
        throw new HubError(`${this.nameOf(this.active)}: ${explainStatus(status, this.timeoutMs)}`, status);
      }
      const b = body as {
        dbStats?: { numFidRegistrations?: number };
        numShards?: number;
        shardInfos?: Array<Partial<ShardInfo>>;
        version?: unknown;
      };
      // A 200 is not enough: a status page on the node's domain answered /v1/info with
      // {"online": true} and would have shown as a healthy node with no shards (homiehouse,
      // 2026-11-11). Only a body with shardInfos is a Snapchain API; anything else is down,
      // with a message that says what answered.
      if (!Array.isArray(b.shardInfos)) {
        throw new HubError(`${this.nameOf(this.active)}: answered, but not with a Snapchain API (no shardInfos in /v1/info)`, status);
      }
      const shards: ShardInfo[] = b.shardInfos.map((s) => ({
        shardId: Number(s.shardId ?? -1),
        maxHeight: Number(s.maxHeight ?? 0),
        blockDelay: Number(s.blockDelay ?? 0),
        ...(s.numMessages !== undefined ? { numMessages: Number(s.numMessages) } : {}),
      }));
      const delays = shards.map((s) => s.blockDelay);
      return {
        side: this.side,
        at,
        reachable: true,
        provider: this.nameOf(this.active),
        note: this.primaryNote(),
        maxBlockDelay: delays.length > 0 ? Math.max(...delays) : null,
        numShards: typeof b.numShards === "number" && b.numShards > 0 ? b.numShards : null,
        numFidRegistrations: b.dbStats?.numFidRegistrations ?? null,
        shards,
        error: null,
        // Short and printable only: this string reaches the page and Telegram as-is.
        version: typeof b.version === "string" && /^[\w.+-]{1,32}$/.test(b.version) ? b.version : null,
      };
    } catch (e) {
      return {
        side: this.side,
        at,
        reachable: false,
        provider: null,
        note: null,
        maxBlockDelay: null,
        numShards: null,
        numFidRegistrations: null,
        shards: [],
        error: e instanceof Error ? e.message : String(e),
        version: null,
      };
    }
  }

  /** All live casts by an FID with timestamps in [startUnixSec, stopUnixSec]. */
  async castsByFid(fid: number, startUnixSec: number, stopUnixSec: number, maxPages: number): Promise<HubMessage[]> {
    const out: HubMessage[] = [];
    let pageToken = "";
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({
        fid: String(fid),
        pageSize: "100",
        startTimestamp: String(toFarcasterSec(startUnixSec)),
        stopTimestamp: String(toFarcasterSec(stopUnixSec)),
      });
      if (pageToken !== "") q.set("pageToken", pageToken);
      const { status, body } = await this.get(`/v1/castsByFid?${q.toString()}`);
      if (status !== 200) throw new HubError(`castsByFid fid=${fid} returned HTTP ${status}`, status);
      const b = body as { messages?: HubMessage[]; nextPageToken?: string };
      for (const m of b.messages ?? []) {
        // A native account's fid is a string on the wire. A message whose fid cannot be read
        // is skipped rather than stored under a wrong number.
        const fid = normalizeFid((m as { data?: { fid?: unknown } }).data?.fid);
        if (fid === null) continue;
        out.push(m.data.fid === fid ? m : { ...m, data: { ...m.data, fid } });
      }
      pageToken = b.nextPageToken ?? "";
      if (pageToken === "") return out;
    }
    throw new HubError(`castsByFid fid=${fid} exceeded ${maxPages} pages; raise MAX_PAGES_PER_FID`, null);
  }

  /**
   * Recent merge events on one shard: (fid, type, shardIndex), newest first.
   * Only message types that `route_message` routes by FID hash are returned. Storage lends and
   * channel messages route to shard 0 and are applied elsewhere (a lend from fid 9152 was
   * observed on the recipient's shard), so they say nothing about the hash function.
   */
  async recentMergeFids(
    shardIndex: number,
    pageSize: number,
  ): Promise<Array<{ fid: number; type: string; shardIndex: number }>> {
    const q = new URLSearchParams({ shard_index: String(shardIndex), reverse: "true", pageSize: String(pageSize) });
    const { status, body } = await this.get(`/v1/events?${q.toString()}`);
    if (status !== 200) throw new HubError(`events shard=${shardIndex} returned HTTP ${status}`, status);
    const events = (body as { events?: Array<Record<string, unknown>> }).events ?? [];
    const out: Array<{ fid: number; type: string; shardIndex: number }> = [];
    for (const e of events) {
      if (e.type !== "HUB_EVENT_TYPE_MERGE_MESSAGE") continue;
      const data = (e as { mergeMessageBody?: { message?: { data?: { fid?: unknown; type?: string } } } }).mergeMessageBody?.message?.data;
      const si = (e as { shardIndex?: number }).shardIndex;
      const fid = normalizeFid(data?.fid);
      if (fid === null || typeof data?.type !== "string" || typeof si !== "number") continue;
      if (!FID_HASH_ROUTED_TYPES.has(data.type)) continue;
      out.push({ fid, type: data.type, shardIndex: si });
    }
    return out;
  }

  /**
   * Whether this node has a registration for the FID. A FID registered on one network only
   * (a Hypersnap native account, or a Hypersnap on-network FID) returns false on the other
   * network's node, and nothing it signs can ever appear there.
   * Legacy FIDs (< 2^32) are looked up as ID_REGISTER on-chain events. Native FIDs (>= 2^32)
   * have no on-chain event anywhere; they are looked up at /v1/nativeAccount, which answers
   * HTTP 400 "NotFound" for an unknown one on Hypersnap and 404 on a Snapchain node (it does
   * not serve the route), both read as false, so a native cast missing on Snapchain is
   * relay_filtered: the shuttle never relays native accounts, by design.
   * true = registered here, false = unknown here, throws = could not tell.
   */
  async knowsFid(fid: number): Promise<boolean> {
    if (fid >= FIRST_NATIVE_FID) {
      const { status, body } = await this.get(`/v1/nativeAccount?fid=${fid}`);
      if (status === 200) return true;
      if (isNotFound(status, body)) return false;
      throw new HubError(`nativeAccount fid=${fid} returned HTTP ${status}`, status);
    }
    const q = new URLSearchParams({ fid: String(fid), event_type: "EVENT_TYPE_ID_REGISTER", pageSize: "1" });
    const { status, body } = await this.get(`/v1/onChainEventsByFid?${q.toString()}`);
    if (status === 200) {
      const events = (body as { events?: unknown[] }).events;
      return Array.isArray(events) && events.length > 0;
    }
    if (isNotFound(status, body)) return false;
    throw new HubError(`onChainEventsByFid fid=${fid} returned HTTP ${status}`, status);
  }

  /** true = present, false = definitely absent, throws = could not tell. */
  async hasCast(fid: number, hash: string): Promise<boolean> {
    const q = new URLSearchParams({ fid: String(fid), hash });
    const { status, body } = await this.get(`/v1/castById?${q.toString()}`);
    if (status === 200) return true;
    if (isNotFound(status, body)) return false;
    throw new HubError(`castById returned HTTP ${status}`, status);
  }
}
