/** Which configured node. Labels ("snapchain", "hypersnap") come from config. */
export type Side = "a" | "b";

export const otherSide = (s: Side): Side => (s === "a" ? "b" : "a");

/**
 * Why two nodes disagree about a message.
 *
 * pending        Seen on one side only; not old enough to judge yet.
 * sync_lag       The missing side got it later. Expected, not suspicious.
 * relay_filtered The relay between the networks does not carry it by design: its message type
 *                is on the filtered list, or its FID is registered on one network only.
 *                Expected once the networks are forked.
 * version_rule   Uses fields or limits only one rule set accepts (V21/V22). Expected.
 * unexplained    Valid under both rule sets, still missing after the timeout. Flag these.
 */
export type Cause = "pending" | "sync_lag" | "relay_filtered" | "version_rule" | "unexplained";

export const CAUSES: readonly Cause[] = ["pending", "sync_lag", "relay_filtered", "version_rule", "unexplained"];

export interface CastAddBody {
  text?: string;
  embeds?: unknown[];
  mentions?: number[];
  parentCastId?: { fid: number; hash: string };
  parentUrl?: string;
  type?: string;
  /** V22 (ChainedCasts) field. */
  formatVersion?: number;
  /** V22 (ChainedCasts) field. */
  chain?: unknown;
  [k: string]: unknown;
}

export interface HubMessage {
  hash: string;
  data: {
    type: string;
    fid: number;
    /** Seconds since the Farcaster epoch (2021-01-01T00:00:00Z). */
    timestamp: number;
    network?: string;
    castAddBody?: CastAddBody;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface ShardInfo {
  shardId: number;
  maxHeight: number;
  blockDelay: number;
  numMessages?: number;
}

export interface InfoSnapshot {
  side: Side;
  at: number; // unix ms
  reachable: boolean;
  /** Worst blockDelay across shards. Null when unreachable. */
  maxBlockDelay: number | null;
  /** Number of DATA shards (excludes shard 0), from /v1/info numShards. */
  numShards: number | null;
  /** Upper bound for random FID sampling, from dbStats. */
  numFidRegistrations: number | null;
  shards: ShardInfo[];
  error: string | null;
}

export interface NewDiff {
  hash: string;
  fid: number;
  /** Data shard that holds this FID, or null when numShards was unknown at insert time. */
  shard: number | null;
  msgTimestamp: number; // unix seconds
  presentOn: Side;
  missingOn: Side;
  messageJson: string;
  firstSeen: number; // unix ms
}

export interface NewStall {
  side: Side;
  shardId: number;
  stuckHeight: number;
  peerHeightStart: number;
  startedAt: number; // unix ms
}

export interface StallRow extends NewStall {
  id: number;
  endedAt: number | null;
  peerHeightEnd: number | null;
  maxBlockDelay: number;
}

export interface DiffRow extends NewDiff {
  id: number;
  cause: Cause;
  note: string | null;
  lastChecked: number | null;
  attempts: number;
  resolvedAt: number | null;
}

export interface DiffFilter {
  cause?: Cause;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

export interface Summary {
  byCause: Record<Cause, number>;
  byMissingSide: Record<Side, number>;
  scans: number;
  lastScanAt: number | null;
  openStalls: number;
  totalStalls: number;
}

export interface ScanRun {
  startedAt: number;
  finishedAt: number;
  fidsScanned: number;
  messagesA: number;
  messagesB: number;
  newDiffs: number;
  errors: number;
}
