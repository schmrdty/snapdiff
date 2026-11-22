// Consensus view: per network and shard, how many validators of the current set can vote
// right now, against the quorum the set needs. Built from what snapdiff already has: each
// node's /v1/info heights, its key (from the peer id in /v1/info), and the validators file.
//
// Why "at tip" and not "signed": the HTTP API has no block or chunk route, so the signers
// of a block are only on gRPC (GetShardChunks, port 3383), which every operator keeps
// private. A validator whose shard height is at the network's tip can vote on that shard;
// one that is behind, down, or not monitored cannot be counted on. That is what diagnosed
// the 2026-11-21 shard 1 halt by hand (rainonme's shard 1 sixteen hours behind while its
// other shards were current). If upstream ever exposes commits over HTTP, this file is
// where the signed count replaces the at-tip count.
import type { ValidatorSet } from "./validators.js";

export interface ConsensusNode {
  label: string;
  /** Display name. */
  name: string;
  /** First 8 hex of the consensus key, from the node's peer id; null when unknown. */
  keyPrefix: string | null;
  reachable: boolean;
  shards: ReadonlyArray<{ shardId: number; maxHeight: number }>;
}

export interface ShardConsensus {
  shardId: number;
  /** Keys in the set in force for this shard at the tip height. */
  setSize: number;
  /** Signatures a block needs: more than two thirds of the set. */
  quorum: number;
  /** Highest height any monitored node reports for this shard; null when none does. */
  tip: number | null;
  /** Height at which this shard's set was adopted. */
  effectiveAt: number | null;
  /** Validators whose node is reachable and within `tolerance` blocks of the tip. */
  atTip: string[];
  /** Validators whose node answers but lags by more than the tolerance, with the lag. */
  behind: { name: string; lag: number }[];
  /** Validators whose node snapdiff lists but cannot reach. */
  down: string[];
  /** Keys of the set behind no monitored node (prefixes). Counted as unknown, not as votes. */
  unmonitored: string[];
  /** "short": fewer at tip than quorum. "edge": exactly quorum. "ok": margin. "unknown": no set. */
  state: "ok" | "edge" | "short" | "unknown";
}

/** More than two thirds of n: 8 needs 6, 11 needs 8, 4 needs 3. */
export const quorumOf = (n: number): number => Math.floor((2 * n) / 3) + 1;

/** Blocks a validator may trail the tip and still count as able to vote (one poll interval). */
export const AT_TIP_TOLERANCE = 30;

/** The set in force for `shardId` at `height`: newest entry for that shard not after it. */
export function setFor(sets: ReadonlyArray<ValidatorSet>, shardId: number, height: number | null): ValidatorSet | null {
  const forShard = sets.filter((s) => s.shardIds.includes(shardId)).sort((a, b) => a.effectiveAt - b.effectiveAt);
  if (forShard.length === 0) return null;
  if (height === null) return forShard.at(-1) ?? null;
  return [...forShard].reverse().find((s) => s.effectiveAt <= height) ?? null;
}

export function shardConsensus(nodes: ReadonlyArray<ConsensusNode>, sets: ReadonlyArray<ValidatorSet>, tolerance = AT_TIP_TOLERANCE): ShardConsensus[] {
  const shardIds = [...new Set([...sets.flatMap((s) => s.shardIds), ...nodes.flatMap((n) => n.shards.map((s) => s.shardId))])].sort((a, b) => a - b);
  const byKey = new Map<string, ConsensusNode>();
  for (const n of nodes) if (n.keyPrefix !== null && !byKey.has(n.keyPrefix)) byKey.set(n.keyPrefix, n);
  const out: ShardConsensus[] = [];
  for (const shardId of shardIds) {
    const heights = nodes.filter((n) => n.reachable).map((n) => n.shards.find((s) => s.shardId === shardId)?.maxHeight).filter((h): h is number => typeof h === "number");
    // A shard no reachable node reports has no tip to measure against: no row rather than a
    // row that calls every validator down (the file lists shards the monitored nodes may not).
    if (heights.length === 0) continue;
    const tip = Math.max(...heights);
    const set = setFor(sets, shardId, tip);
    if (set === null) { out.push({ shardId, setSize: 0, quorum: 0, tip, effectiveAt: null, atTip: [], behind: [], down: [], unmonitored: [], state: "unknown" }); continue; }
    const atTip: string[] = [];
    const behind: { name: string; lag: number }[] = [];
    const down: string[] = [];
    const unmonitored: string[] = [];
    for (const key of set.keys) {
      const prefix = key.slice(0, 8);
      const node = byKey.get(prefix);
      if (node === undefined) { unmonitored.push(prefix); continue; }
      if (!node.reachable) { down.push(node.name); continue; }
      const h = node.shards.find((s) => s.shardId === shardId)?.maxHeight;
      if (typeof h !== "number") { down.push(node.name); continue; }
      const lag = tip - h;
      if (lag <= tolerance) atTip.push(node.name);
      else behind.push({ name: node.name, lag });
    }
    const quorum = quorumOf(set.keys.length);
    const state = atTip.length < quorum ? "short" : atTip.length === quorum ? "edge" : "ok";
    out.push({ shardId, setSize: set.keys.length, quorum, tip, effectiveAt: set.effectiveAt, atTip, behind, down, unmonitored, state });
  }
  return out;
}

/** One line per shard, the form the Telegram bot and the change log print. */
export function consensusLine(s: ShardConsensus): string {
  if (s.state === "unknown") return `shard ${s.shardId}: validator set not loaded`;
  const parts = [`shard ${s.shardId}: ${s.atTip.length} of ${s.setSize} at tip, quorum ${s.quorum}`];
  if (s.behind.length > 0) parts.push(`behind: ${s.behind.map((b) => `${b.name} (${b.lag.toLocaleString("en-US")})`).join(", ")}`);
  if (s.down.length > 0) parts.push(`down: ${s.down.join(", ")}`);
  if (s.unmonitored.length > 0) parts.push(`not monitored: ${s.unmonitored.length}`);
  return parts.join("; ");
}
