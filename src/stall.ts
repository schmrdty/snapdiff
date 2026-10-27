import type { InfoSnapshot, Side } from "./types.js";

/**
 * A shard on one node that has stopped while the same shard on the other node keeps going.
 *
 * `blockDelay` on /v1/info is `now - timestamp of the newest block` for that shard, so a shard
 * that stops advancing (for example, a node that rejects blocks it cannot validate after a
 * version cutover) shows a delay that climbs one second per second. The other node's healthy
 * delay for the same shard rules out a network-wide slowdown.
 */
export interface ShardStallSignal {
  side: Side;
  shardId: number;
  stuckHeight: number;
  blockDelay: number;
  peerHeight: number;
  peerBlockDelay: number;
}

export function detectStalls(
  a: InfoSnapshot | null,
  b: InfoSnapshot | null,
  behindBlockDelay: number,
): ShardStallSignal[] {
  if (a === null || b === null || !a.reachable || !b.reachable) return [];
  const out: ShardStallSignal[] = [];
  const pairs: Array<[InfoSnapshot, InfoSnapshot]> = [
    [a, b],
    [b, a],
  ];
  for (const [me, peer] of pairs) {
    for (const s of me.shards) {
      const p = peer.shards.find((x) => x.shardId === s.shardId);
      if (p === undefined) continue;
      if (s.blockDelay > behindBlockDelay && p.blockDelay <= behindBlockDelay) {
        out.push({
          side: me.side,
          shardId: s.shardId,
          stuckHeight: s.maxHeight,
          blockDelay: s.blockDelay,
          peerHeight: p.maxHeight,
          peerBlockDelay: p.blockDelay,
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
