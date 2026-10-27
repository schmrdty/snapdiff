import { createHash } from "node:crypto";

/**
 * Which data shard holds a FID's messages. Transcribed from `ShardRouter::route_fid` in
 * `src/mempool/routing.rs`, identical in farcasterxyz/snapchain and farcasterorg/hypersnap:
 *
 *   hash = SHA256((fid as FidOnDisk).to_be_bytes())     // FidOnDisk = u32, so 4 bytes
 *   (first 4 bytes of hash as big-endian u32) % num_shards + 1
 *
 * Upstream marks it "DO NOT CHANGE THE HASHING FUNCTION" because trie keys depend on it.
 * `npm run check-nodes` verifies this against live /v1/events, so a transcription error
 * shows up there, not in the diffs. (The first transcription used 8 bytes and failed that
 * check against haatz.quilibrium.com: 44 of 65 messages on the wrong shard.)
 *
 * @param numShards number of DATA shards (shard 0, the block shard, is excluded).
 */
export function shardForFid(fid: number, numShards: number): number {
  if (!Number.isInteger(fid) || fid < 0 || fid > 0xffff_ffff) throw new Error(`bad fid ${fid}`);
  if (!Number.isInteger(numShards) || numShards < 1) throw new Error(`bad numShards ${numShards}`);
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(fid);
  const hash = createHash("sha256").update(buf).digest();
  return (hash.readUInt32BE(0) % numShards) + 1;
}
