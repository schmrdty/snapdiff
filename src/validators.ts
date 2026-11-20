// The validator set, read from the network's validators file (the same file every node
// loads), so that the peer view can tell a validator from a read node without the admin-gated
// /v1/mesh endpoint. /v1/currentPeers lists peer ids only; a Hypersnap peer id is the node's
// ed25519 public key behind a fixed six-byte prefix, and that key is its consensus key, so
// membership in the set is a derivation plus a lookup. Operators lock /v1/mesh down (haatz,
// 2026-11-20) and may lock more; currentPeers is the ordinary API and stays open.
//
// Safety contract: the file is parsed with regular expressions after every comment is
// stripped, so operator names in comments never reach memory past this function; only
// 64-hex keys, shard ids and heights are kept. Fetches run from the server (the VPS), never
// from a browser, and a failed fetch keeps the last good copy.
import { PEER_ID_RE } from "./mesh.js";

export interface ValidatorSet {
  effectiveAt: number;
  shardIds: number[];
  /** Full 64-hex keys, in file order. */
  keys: string[];
}

/** The set as it applies to one network at its current heights. */
export interface ResolvedSets {
  /** Key prefix (8 hex) → true for every key in the current set of at least one shard. */
  current: Set<string>;
  /** Key prefix → the earliest height at which a key not yet current joins, and on which shard. */
  next: Map<string, { effectiveAt: number; shardId: number }>;
  /** Size of the current set on the shard with the most validators (the "N" in "A of N"). */
  size: number;
}

const KEY_RE = /^[0-9a-f]{64}$/;

/** Parse every [[consensus.validator_sets]] block. Comments are dropped first. */
export function parseValidatorSets(text: string): ValidatorSet[] {
  const clean = text.replace(/#[^\n]*/g, "");
  const out: ValidatorSet[] = [];
  const blocks = clean.split(/\[\[consensus\.validator_sets\]\]/).slice(1);
  for (const b of blocks) {
    const body = b.split(/\n\s*\[/)[0] ?? "";
    const ea = /effective_at\s*=\s*([0-9_]+)/.exec(body);
    const shards = /shard_ids\s*=\s*\[([^\]]*)\]/.exec(body);
    const keysBlock = /validator_public_keys\s*=\s*\[([^\]]*)\]/.exec(body);
    if (ea === null || shards === null || keysBlock === null) continue;
    const effectiveAt = Number(ea[1]!.replace(/_/g, ""));
    const shardIds = shards[1]!.split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number).filter((n) => Number.isSafeInteger(n) && n >= 0);
    const keys = [...keysBlock[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!.toLowerCase()).filter((k) => KEY_RE.test(k));
    if (!Number.isSafeInteger(effectiveAt) || shardIds.length === 0 || keys.length === 0) continue;
    out.push({ effectiveAt, shardIds, keys });
  }
  return out;
}

/**
 * Current and next sets per shard at the given heights. A shard with no height yet (no info
 * read) takes its latest set as current. `size` is the largest current set across shards.
 */
export function resolveSets(sets: ValidatorSet[], heightOf: (shardId: number) => number | null): ResolvedSets {
  const current = new Set<string>();
  const next = new Map<string, { effectiveAt: number; shardId: number }>();
  let size = 0;
  const shardIds = [...new Set(sets.flatMap((s) => s.shardIds))].sort((a, b) => a - b);
  for (const shardId of shardIds) {
    const forShard = sets.filter((s) => s.shardIds.includes(shardId)).sort((a, b) => a.effectiveAt - b.effectiveAt);
    const h = heightOf(shardId);
    const cur = h === null ? forShard.at(-1) : [...forShard].reverse().find((s) => s.effectiveAt <= h);
    if (cur === undefined) continue;
    size = Math.max(size, cur.keys.length);
    for (const k of cur.keys) current.add(k.slice(0, 8));
    if (h !== null) {
      for (const s of forShard) {
        if (s.effectiveAt <= h) continue;
        for (const k of s.keys) {
          const p = k.slice(0, 8);
          const prev = next.get(p);
          if (prev === undefined || s.effectiveAt < prev.effectiveAt) next.set(p, { effectiveAt: s.effectiveAt, shardId });
        }
      }
    }
  }
  for (const p of current) next.delete(p);
  return { current, next, size };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Identity multihash of an ed25519 libp2p key: 0x00 0x24, protobuf key type 1, 32 bytes. */
const PEER_ID_PREFIX = "002408011220";

/** The 64-hex ed25519 public key behind a 12D3KooW peer id; null for anything else. */
export function keyFromPeerId(peerId: string): string | null {
  if (!PEER_ID_RE.test(peerId)) return null;
  let n = 0n;
  for (const ch of peerId) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  // Leading zero bytes are leading '1' characters in base58; the prefix starts with one.
  hex = hex.padStart(76, "0");
  if (hex.length !== 76 || !hex.startsWith(PEER_ID_PREFIX)) return null;
  return hex.slice(12);
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Fetches each network's validators file on a timer, keeps the last good parse, logs changes. */
export class ValidatorSetMonitor {
  private readonly latest = new Map<string, { sets: ValidatorSet[]; fetchedAt: number }>();

  constructor(
    private readonly urls: Record<string, string>,
    private readonly log: (m: string) => void = () => {},
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async runAll(): Promise<void> {
    await Promise.all(
      Object.entries(this.urls).map(async ([network, url]) => {
        let text: string;
        try {
          const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "text/plain" } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          text = await res.text();
          if (text.length > 1_000_000) throw new Error("file too large");
        } catch (e) {
          this.log(`[validators] ${network}: fetch failed (${e instanceof Error ? e.message : "error"}); keeping the last copy`);
          return;
        }
        const sets = parseValidatorSets(text);
        if (sets.length === 0) {
          this.log(`[validators] ${network}: no validator sets in the file; keeping the last copy`);
          return;
        }
        const prev = this.latest.get(network);
        const last = sets.reduce((a, b) => (b.effectiveAt > a.effectiveAt ? b : a));
        if (prev === undefined || prev.sets.length !== sets.length || JSON.stringify(prev.sets.at(-1)) !== JSON.stringify(sets.at(-1))) {
          this.log(`[validators] ${network}: ${sets.length} sets, latest effective at ${last.effectiveAt} with ${last.keys.length} keys`);
        }
        this.latest.set(network, { sets, fetchedAt: this.now() });
      }),
    );
  }

  sets(network: string): ValidatorSet[] | null {
    return this.latest.get(network)?.sets ?? null;
  }

  fetchedAt(network: string): number | null {
    return this.latest.get(network)?.fetchedAt ?? null;
  }
}
