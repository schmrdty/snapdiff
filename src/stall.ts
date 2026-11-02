import type { InfoSnapshot, Side } from "./types.js";

/**
 * A shard on one node that has stopped while the same shard on another node keeps going.
 *
 * `blockDelay` on /v1/info is `now - timestamp of the newest block` for that shard, so a shard
 * that stops advancing (for example, a node that rejects blocks it cannot validate after a
 * version cutover) shows a delay that climbs one second per second. A healthy delay for the
 * same shard on another node rules out a network-wide slowdown.
 *
 * With more than two nodes, each node is measured against its HEALTHIEST reachable peer for
 * that shard (the lowest blockDelay). Every node slow on the same shard is a network
 * slowdown, not a stall, and is not recorded.
 */
export interface ShardStallSignal {
  side: Side;
  shardId: number;
  stuckHeight: number;
  blockDelay: number;
  peer: Side;
  peerHeight: number;
  peerBlockDelay: number;
}

export function detectStalls(infos: ReadonlyArray<InfoSnapshot | null>, behindBlockDelay: number): ShardStallSignal[] {
  const live = infos.filter((i): i is InfoSnapshot => i !== null && i.reachable);
  if (live.length < 2) return [];
  const out: ShardStallSignal[] = [];
  for (const me of live) {
    for (const s of me.shards) {
      let best: { node: InfoSnapshot; shard: InfoSnapshot["shards"][number] } | null = null;
      for (const other of live) {
        if (other.side === me.side) continue;
        const p = other.shards.find((x) => x.shardId === s.shardId);
        if (p === undefined) continue;
        if (best === null || p.blockDelay < best.shard.blockDelay) best = { node: other, shard: p };
      }
      if (best === null) continue;
      if (s.blockDelay > behindBlockDelay && best.shard.blockDelay <= behindBlockDelay) {
        out.push({
          side: me.side,
          shardId: s.shardId,
          stuckHeight: s.maxHeight,
          blockDelay: s.blockDelay,
          peer: best.node.side,
          peerHeight: best.shard.maxHeight,
          peerBlockDelay: best.shard.blockDelay,
        });
      }
    }
  }
  return out;
}

/** True when `side` cannot currently be trusted to have `shardId` up to date. */
export function shardBehind(info: InfoSnapshot | null, shardId: number | null, behindBlockDelay: number): boolean {
  if (info === null || !info.reachable) return true;
  if (shardId === null) return info.maxBlockDelay !== null && info.maxBlockDelay > behindBlockDelay;
  const s = info.shards.find((x) => x.shardId === shardId);
  if (s === undefined) return info.maxBlockDelay !== null && info.maxBlockDelay > behindBlockDelay;
  return s.blockDelay > behindBlockDelay;
}
