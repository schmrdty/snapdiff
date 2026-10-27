import type { Cause, DiffFilter, DiffRow, InfoSnapshot, NewDiff, NewStall, ScanRun, Side, StallRow, Summary } from "../types.js";

/**
 * Storage boundary. Everything else talks to this interface only, so swapping SQLite
 * for SpacetimeDB means writing one new implementation (see spacetime.ts).
 * Methods are async even though SQLite is sync, because a networked store is not.
 */
export interface Store {
  recordInfo(s: InfoSnapshot): Promise<void>;
  latestInfo(side: Side): Promise<InfoSnapshot | null>;
  recentInfo(side: Side, limit: number): Promise<InfoSnapshot[]>;

  /** Inserts if (hash, missingOn) is new. Returns true when inserted. */
  insertDiff(d: NewDiff): Promise<boolean>;
  /** Diffs due for a recheck: cause pending or unexplained, inside the window, not checked recently. */
  dueForRecheck(now: number, recheckAfterMs: number, windowMs: number, limit: number): Promise<DiffRow[]>;
  updateVerdict(id: number, cause: Cause, note: string | null, checkedAt: number, resolved: boolean): Promise<void>;
  listDiffs(f: DiffFilter): Promise<DiffRow[]>;

  recordScan(r: ScanRun): Promise<void>;

  /** Stalls with no endedAt. */
  openStalls(): Promise<StallRow[]>;
  startStall(s: NewStall): Promise<number>;
  /** Called every info tick while a stall is open, so the record keeps its worst delay. */
  touchStall(id: number, maxBlockDelay: number): Promise<void>;
  endStall(id: number, endedAt: number, peerHeightEnd: number): Promise<void>;
  listStalls(f: { fromMs?: number; toMs?: number; limit?: number }): Promise<StallRow[]>;

  summary(): Promise<Summary>;
  close(): Promise<void>;
}
