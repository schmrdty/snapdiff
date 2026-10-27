import type { HubMessage, InfoSnapshot, ShardInfo, Side } from "./types.js";

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
export class HubClient {
  constructor(
    readonly side: Side,
    readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly headers: Record<string, string> = {},
  ) {}

  private async get(path: string): Promise<{ status: number; body: unknown }> {
    // Some hosted nodes (Neynar) return 403 to Node's default User-Agent. Always identify.
    const headers = { "user-agent": "snapdiff/0.4 (+read-only comparator)", ...this.headers };
    let res = await fetch(`${this.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    // Hosted nodes rate-limit. Back off briefly before giving up; a 429 that persists is an
    // error for this request, which the scan then skips without creating a diff.
    for (const waitMs of [1000, 3000]) {
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, waitMs));
      res = await fetch(`${this.baseUrl}${path}`, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
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

  async info(): Promise<InfoSnapshot> {
    const at = Date.now();
    try {
      const { status, body } = await this.get("/v1/info");
      if (status !== 200 || typeof body !== "object" || body === null) {
        throw new HubError(`/v1/info returned HTTP ${status}`, status);
      }
      const b = body as {
        dbStats?: { numFidRegistrations?: number };
        numShards?: number;
        shardInfos?: Array<Partial<ShardInfo>>;
      };
      const shards: ShardInfo[] = (b.shardInfos ?? []).map((s) => ({
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
        maxBlockDelay: delays.length > 0 ? Math.max(...delays) : null,
        numShards: typeof b.numShards === "number" && b.numShards > 0 ? b.numShards : null,
        numFidRegistrations: b.dbStats?.numFidRegistrations ?? null,
        shards,
        error: null,
      };
    } catch (e) {
      return {
        side: this.side,
        at,
        reachable: false,
        maxBlockDelay: null,
        numShards: null,
        numFidRegistrations: null,
        shards: [],
        error: e instanceof Error ? e.message : String(e),
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
      out.push(...(b.messages ?? []));
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
      const data = (e as { mergeMessageBody?: { message?: { data?: { fid?: number; type?: string } } } }).mergeMessageBody?.message?.data;
      const si = (e as { shardIndex?: number }).shardIndex;
      if (typeof data?.fid !== "number" || typeof data.type !== "string" || typeof si !== "number") continue;
      if (!FID_HASH_ROUTED_TYPES.has(data.type)) continue;
      out.push({ fid: data.fid, type: data.type, shardIndex: si });
    }
    return out;
  }

  /**
   * Whether this node has an ID registration for the FID. A FID registered on one network
   * only (for example a Hypersnap on-network FID) returns false on the other network's node,
   * and nothing it signs can ever appear there.
   * true = registered here, false = unknown here, throws = could not tell.
   */
  async knowsFid(fid: number): Promise<boolean> {
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
