import type { Store } from "./store.js";
import type { Cause, DiffFilter, DiffRow, InfoSnapshot, NewDiff, NewStall, ScanRun, Side, StallRow, Summary } from "../types.js";

/**
 * SpacetimeDB implementation: placeholder. Fill this in when other people want to watch live.
 *
 * Layout (keeps beta "procedures" out of the critical path):
 *   1. This process stays the poller. It talks to both nodes over HTTP, as it does now.
 *   2. Each Store method calls a reducer through the SpacetimeDB TypeScript client SDK:
 *        recordInfo    -> reducer record_info(side, at, reachable, max_block_delay, ...)
 *        insertDiff    -> reducer insert_diff(hash, fid, ...)   (unique index on hash + missing_on)
 *        updateVerdict -> reducer update_verdict(id, cause, note, checked_at, resolved)
 *        recordScan    -> reducer record_scan(...)
 *   3. Reads (latestInfo, dueForRecheck, listDiffs, summary) come from the client cache of a
 *      subscription to the same three tables. The dashboard becomes a SpacetimeDB client that
 *      subscribes to `diffs` and `info_snapshots`, so updates push live with no polling.
 *   4. Table columns: copy them from SCHEMA in sqlite.ts one-to-one.
 *
 * Then switch the one line in index.ts that constructs SqliteStore.
 */
export class SpacetimeStore implements Store {
  constructor(
    readonly uri: string,
    readonly moduleName: string,
  ) {}

  private nope(): never {
    throw new Error("SpacetimeStore is not implemented yet. Use SqliteStore (STORE=sqlite).");
  }

  recordInfo(_s: InfoSnapshot): Promise<void> { return this.nope(); }
  latestInfo(_side: Side): Promise<InfoSnapshot | null> { return this.nope(); }
  recentInfo(_side: Side, _limit: number): Promise<InfoSnapshot[]> { return this.nope(); }
  insertDiff(_d: NewDiff): Promise<boolean> { return this.nope(); }
  dueForRecheck(_now: number, _a: number, _w: number, _l: number): Promise<DiffRow[]> { return this.nope(); }
  updateVerdict(_id: number, _c: Cause, _n: string | null, _t: number, _r: boolean): Promise<void> { return this.nope(); }
  listDiffs(_f: DiffFilter): Promise<DiffRow[]> { return this.nope(); }
  recordScan(_r: ScanRun): Promise<void> { return this.nope(); }
  openStalls(): Promise<StallRow[]> { return this.nope(); }
  startStall(_s: NewStall): Promise<number> { return this.nope(); }
  touchStall(_id: number, _d: number): Promise<void> { return this.nope(); }
  endStall(_id: number, _t: number, _h: number): Promise<void> { return this.nope(); }
  listStalls(_f: { fromMs?: number; toMs?: number; limit?: number }): Promise<StallRow[]> { return this.nope(); }
  summary(): Promise<Summary> { return this.nope(); }
  close(): Promise<void> { return Promise.resolve(); }
}
