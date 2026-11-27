// Testnet cast explorer. The Testnet tab lists the newest casts on each testnet network so
// an operator or app developer can see that their post landed, without a client. Operator,
// 2026-11-18.
//
// Source: the network's reference node, hub API only (works with `[api]` off):
//   1. /v1/fids?shard_id=S for every data shard: every registered FID (native FIDs included;
//      checked 2026-11-18, the first native FID 4294967296 is listed on both shards).
//   2. /v1/castsByFid?fid=F&reverse=true, one page per FID, newest first.
// Merged, newest first, capped. Fine while a testnet has hundreds of accounts; past that the
// poller switches to the events stream (left as the next step, noted in README).
//
// Safety contract: the only strings taken from a response are the cast text (escaped by the
// page, clipped here) and the hash (hex-checked); every number is range-checked; failures are
// fixed phrases. Nothing from a response is ever a link or a header.
import type { HubClient } from "./hub.js";
import { toUnixSec } from "./hub.js";
import type { HubMessage } from "./types.js";

export const FEED_MAX_FIDS = 500;
export const FEED_CASTS_PER_FID = 50;
export const FEED_KEEP = 100;
export const FEED_TEXT_MAX = 320;

export interface FeedCast {
  network: string;
  fid: number;
  /** Unix ms, from the message's Farcaster timestamp. */
  at: number;
  text: string;
  /** 0x plus 40 hex characters. */
  hash: string;
  /** Reply target: a cast hash prefix or a parent URL host, else null. Display only. */
  replyTo: string | null;
  embeds: number;
}

export interface FeedSnapshot {
  network: string;
  /** Reference node label the feed was read from. */
  source: string;
  casts: FeedCast[];
  fids: number;
  /** Last attempt, unix ms; null before the first. */
  checkedAt: number | null;
  /** Fixed-phrase reason the last round failed; null after a success. */
  error: string | null;
}

const HASH_RE = /^0x[0-9a-f]{40}$/;

/** Cast rows out of castsByFid messages for one FID. Anything malformed is skipped. */
export function castsFromMessages(network: string, msgs: HubMessage[]): FeedCast[] {
  const out: FeedCast[] = [];
  for (const m of msgs) {
    const d = m.data;
    if (d.type !== "MESSAGE_TYPE_CAST_ADD" || !d.castAddBody) continue;
    const fid = Number(d.fid);
    const ts = Number(d.timestamp);
    const hash = String(m.hash ?? "").toLowerCase();
    if (!Number.isSafeInteger(fid) || fid <= 0 || !Number.isFinite(ts) || ts <= 0 || !HASH_RE.test(hash)) continue;
    const body = d.castAddBody as { text?: unknown; embeds?: unknown; parentCastId?: { hash?: unknown } | null; parentUrl?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    const parentHash = typeof body.parentCastId?.hash === "string" ? body.parentCastId.hash.toLowerCase() : "";
    let replyTo: string | null = null;
    if (HASH_RE.test(parentHash)) replyTo = `${parentHash.slice(0, 10)}…`;
    else if (typeof body.parentUrl === "string" && body.parentUrl !== "") {
      try {
        replyTo = new URL(body.parentUrl).host || "url";
      } catch {
        replyTo = "url";
      }
    }
    out.push({ network, fid, at: toUnixSec(ts) * 1000, text: text.length > FEED_TEXT_MAX ? `${text.slice(0, FEED_TEXT_MAX)}…` : text, hash, replyTo, embeds: Array.isArray(body.embeds) ? body.embeds.length : 0 });
  }
  return out;
}

export class TestnetFeed {
  private latest = new Map<string, FeedSnapshot>();

  /** feeds: network name to the HubClient of its reference node (plus its label and data shard count). */
  constructor(
    private readonly feeds: Record<string, { hub: HubClient; source: string; shards: () => number[] }>,
    private readonly log: (m: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    for (const [network, f] of Object.entries(feeds)) this.latest.set(network, { network, source: f.source, casts: [], fids: 0, checkedAt: null, error: null });
  }

  async runAll(): Promise<void> {
    for (const [network, f] of Object.entries(this.feeds)) {
      const prev = this.latest.get(network)!;
      try {
        const fidSet = new Set<number>();
        for (const shard of f.shards()) for (const fid of await f.hub.fids(shard, 1000, 10)) fidSet.add(fid);
        // Newest accounts first when there are too many: FIDs are assigned in order.
        const fids = [...fidSet].sort((a, b) => b - a).slice(0, FEED_MAX_FIDS);
        const casts: FeedCast[] = [];
        for (const fid of fids) casts.push(...castsFromMessages(network, await f.hub.recentCasts(fid, FEED_CASTS_PER_FID)));
        casts.sort((a, b) => b.at - a.at || a.hash.localeCompare(b.hash));
        const kept = casts.slice(0, FEED_KEEP);
        if (kept.length !== prev.casts.length || kept[0]?.hash !== prev.casts[0]?.hash) this.log(`[testnet-feed] ${network}: ${fidSet.size} fids, ${casts.length} casts seen, newest ${kept[0]?.hash.slice(0, 10) ?? "none"}`);
        this.latest.set(network, { network, source: f.source, casts: kept, fids: fidSet.size, checkedAt: this.now(), error: null });
      } catch (e) {
        const error = e instanceof Error && e.message.includes("HTTP") ? "node answered with an error" : "node did not answer";
        if (prev.error !== error) this.log(`[testnet-feed] ${network}: ${error}`);
        this.latest.set(network, { ...prev, checkedAt: this.now(), error });
      }
    }
  }

  snapshot(): Record<string, FeedSnapshot> {
    return Object.fromEntries([...this.latest.entries()].map(([k, v]) => [k, { ...v, casts: v.casts.map((c) => ({ ...c })) }]));
  }
}
