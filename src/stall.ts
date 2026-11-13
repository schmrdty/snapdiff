import type { InfoSnapshot, Side, StallScope } from "./types.js";

/**
 * A shard on one node that has stopped while the same shard keeps going elsewhere.
 *
 * `blockDelay` on /v1/info is `now - timestamp of the newest block` for that shard, so a shard
 * that stops advancing (for example, a node that rejects blocks it cannot validate after a
 * version cutover) shows a delay that climbs one second per second.
 *
 * Since the 2026-11-12 fork the networks produce blocks at different rates and their heights
 * no longer match, so a node is measured against its OWN network only (`networkOf`; without
 * it every node counts as one network):
 *
 * - scope "node": the healthiest reachable peer on the same network (lowest blockDelay) is
 *   under the threshold while this node is over it. That node's problem.
 * - scope "network": every reachable node of its network is over the threshold on that
 *   shard (or it is the only node of its network). The network stopped deciding blocks:
 *   on 2026-11-12 23:36 UTC all seven hypersnap nodes stopped at one height for 85 s when
 *   the validators lost quorum. Recorded once per node so each node's history is complete;
 *   the dashboard and the bot collapse the rows into one network-wide line. The peer is then
 *   the healthiest node on any other network, kept as evidence that time passed. When no
 *   node anywhere is healthy nothing is recorded: that is a clock or probe problem.
 */
export interface ShardStallSignal {
  side: Side;
  shardId: number;
  stuckHeight: number;
  blockDelay: number;
  scope: StallScope;
  peer: Side;
  peerHeight: number;
  peerBlockDelay: number;
}

type Pick = { node: InfoSnapshot; shard: InfoSnapshot["shards"][number] };

export function detectStalls(
  infos: ReadonlyArray<InfoSnapshot | null>,
  behindBlockDelay: number,
  networkOf: (side: Side) => string = () => "",
): ShardStallSignal[] {
  const live = infos.filter((i): i is InfoSnapshot => i !== null && i.reachable);
  if (live.length < 2) return [];
  const healthiest = (pool: InfoSnapshot[], shardId: number): Pick | null => {
    let best: Pick | null = null;
    for (const other of pool) {
      const p = other.shards.find((x) => x.shardId === shardId);
      if (p === undefined) continue;
      if (best === null || p.blockDelay < best.shard.blockDelay) best = { node: other, shard: p };
    }
    return best;
  };
  const out: ShardStallSignal[] = [];
  for (const me of live) {
    const net = networkOf(me.side);
    for (const s of me.shards) {
      if (s.blockDelay <= behindBlockDelay) continue;
      const same = healthiest(live.filter((o) => o.side !== me.side && networkOf(o.side) === net), s.shardId);
      let scope: StallScope;
      let peer: Pick;
      if (same !== null && same.shard.blockDelay <= behindBlockDelay) {
        scope = "node";
        peer = same;
      } else {
        const other = healthiest(live.filter((o) => networkOf(o.side) !== net), s.shardId);
        if (other === null || other.shard.blockDelay > behindBlockDelay) continue;
        scope = "network";
        peer = other;
      }
      out.push({
        side: me.side,
        shardId: s.shardId,
        stuckHeight: s.maxHeight,
        blockDelay: s.blockDelay,
        scope,
        peer: peer.node.side,
        peerHeight: peer.shard.maxHeight,
        peerBlockDelay: peer.shard.blockDelay,
      });
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
