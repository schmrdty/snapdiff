import { createHash } from "node:crypto";

/** First native-account FID (Hypersnap native registration, 2026-11-12 fork): 2^32. Below it FIDs are legacy, u32 on disk. */
export const FIRST_NATIVE_FID = 2 ** 32;

/**
 * Which data shard holds a FID's messages. Transcribed from `ShardRouter::route_fid` in
 * `src/mempool/routing.rs` (identical in farcasterxyz/snapchain and farcasterorg/hypersnap):
 *
 *   hash = SHA256(make_fid_key(fid))
 *   (first 4 bytes of hash as big-endian u32) % num_shards + 1
 *
 * `make_fid_key` (hypersnap src/storage/store/account/message.rs, since the fork):
 *   legacy fid < 2^32:   4 bytes, the fid as big-endian u32 (what Snapchain always did)
 *   native fid >= 2^32: 12 bytes, four zero bytes then the fid as big-endian u64. FID 0 is
 *                       never an account, so the zero prefix escapes the wide form without
 *                       touching any existing key or trie hash.
 *
 * Upstream marks it "DO NOT CHANGE THE HASHING FUNCTION" because trie keys depend on it.
 * `npm run check-nodes` verifies this against live /v1/events, so a transcription error
 * shows up there, not in the diffs. (The first transcription used 8 bytes and failed that
 * check against haatz.quilibrium.com: 44 of 65 messages on the wrong shard.) The native form
 * is transcribed from source only until a native account posts; check-nodes then confirms it
 * the same way.
 *
 * @param fid a safe integer. Native FIDs are assigned upward from 2^32, far below 2^53.
 * @param numShards number of DATA shards (shard 0, the block shard, is excluded).
 */
export function shardForFid(fid: number, numShards: number): number {
  if (!Number.isSafeInteger(fid) || fid < 0) throw new Error(`bad fid ${fid}`);
  if (!Number.isInteger(numShards) || numShards < 1) throw new Error(`bad numShards ${numShards}`);
  const native = fid >= FIRST_NATIVE_FID;
  const key = Buffer.alloc(native ? 12 : 4);
  if (native) key.writeBigUInt64BE(BigInt(fid), 4);
  else key.writeUInt32BE(fid);
  const hash = createHash("sha256").update(key).digest();
  return (hash.readUInt32BE(0) % numShards) + 1;
}
