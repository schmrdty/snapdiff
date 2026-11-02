/**
 * Which configured node: its label from config ("snapchain", "hypersnap", "ohsnap", ...).
 * One node is the REFERENCE; every other node is compared against it pairwise. Before
 * multi-node (v0.2) this was the literal "a" | "b"; old rows are relabeled on first start.
 */
export type Side = string;

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

/**
 * How far a difference reaches, judged at first sighting from the nodes that answered:
 *
 * node     At least one other node on the missing node's network has the cast. The missing
 *          node is behind or broken; its network is fine.
 * network  Every answering node on the missing node's network lacks the cast. The networks
 *          disagree (or the only node of that network does).
 */
export type Scope = "node" | "network";

export interface NewDiff {
  hash: string;
  fid: number;
  /** Data shard that holds this FID, or null when numShards was unknown at insert time. */
  shard: number | null;
  msgTimestamp: number; // unix seconds
  /** One node that had the cast: the reference when it did, else the first in config order. */
  presentOn: Side;
  missingOn: Side;
  /** Every answering node that had the cast when this row was written, in config order. */
  presentNodes: Side[];
  scope: Scope;
  /** Network of the missing node, denormalized so the store can group without config. */
  missingNetwork: string;
  messageJson: string;
  firstSeen: number; // unix ms
}

export interface NewStall {
  side: Side;
  shardId: number;
  stuckHeight: number;
  /** The healthy node this shard was measured against. */
  peer: Side;
  peerHeightStart: number;
  startedAt: number; // unix ms
}

export interface StallRow extends Omit<NewStall, "peer"> {
  id: number;
  /** Null only on rows written before multi-node. */
  peer: Side | null;
  endedAt: number | null;
  peerHeightEnd: number | null;
  maxBlockDelay: number;
}

export interface DiffRow extends Omit<NewDiff, "scope" | "missingNetwork"> {
  id: number;
  /** Null on rows written before scope existed; presentNodes is [] on those. */
  scope: Scope | null;
  missingNetwork: string | null;
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
  /** Open unexplained diffs per node they are missing on. */
  byMissingNode: Record<Side, number>;
  /** Unexplained diffs by scope (rows without a scope are not counted). */
  byScope: Record<Scope, number>;
  /** Per network: distinct casts missing on every one of its nodes, by cause. */
  networkSplit: Record<string, { unexplained: number; pending: number }>;
  scans: number;
  lastScanAt: number | null;
  openStalls: number;
  totalStalls: number;
}

export interface ScanRun {
  startedAt: number;
  finishedAt: number;
  fidsScanned: number;
  /** Casts fetched per node label during this scan. */
  messagesByNode: Record<Side, number>;
  reference: Side;
  newDiffs: number;
  errors: number;
}
