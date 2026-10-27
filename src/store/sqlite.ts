import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "./store.js";
import {
  CAUSES,
  type Cause,
  type DiffFilter,
  type DiffRow,
  type InfoSnapshot,
  type NewDiff,
  type NewStall,
  type ScanRun,
  type Side,
  type StallRow,
  type Summary,
} from "../types.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS info_snapshots (
  id                    INTEGER PRIMARY KEY,
  side                  TEXT    NOT NULL CHECK (side IN ('a','b')),
  at                    INTEGER NOT NULL,
  reachable             INTEGER NOT NULL,
  max_block_delay       INTEGER,
  num_shards            INTEGER,
  num_fid_registrations INTEGER,
  shards_json           TEXT    NOT NULL,
  error                 TEXT
);
CREATE INDEX IF NOT EXISTS info_side_at ON info_snapshots (side, at DESC);

CREATE TABLE IF NOT EXISTS diffs (
  id            INTEGER PRIMARY KEY,
  hash          TEXT    NOT NULL,
  fid           INTEGER NOT NULL,
  shard         INTEGER,
  msg_timestamp INTEGER NOT NULL,
  present_on    TEXT    NOT NULL CHECK (present_on IN ('a','b')),
  missing_on    TEXT    NOT NULL CHECK (missing_on IN ('a','b')),
  cause         TEXT    NOT NULL DEFAULT 'pending'
                CHECK (cause IN ('pending','sync_lag','relay_filtered','version_rule','unexplained')),
  note          TEXT,
  message_json  TEXT    NOT NULL,
  first_seen    INTEGER NOT NULL,
  last_checked  INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0,
  resolved_at   INTEGER,
  UNIQUE (hash, missing_on)
);
CREATE INDEX IF NOT EXISTS diffs_cause ON diffs (cause, first_seen);
CREATE INDEX IF NOT EXISTS diffs_fid   ON diffs (fid);

CREATE TABLE IF NOT EXISTS scans (
  id           INTEGER PRIMARY KEY,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER NOT NULL,
  fids_scanned INTEGER NOT NULL,
  messages_a   INTEGER NOT NULL,
  messages_b   INTEGER NOT NULL,
  new_diffs    INTEGER NOT NULL,
  errors       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stalls (
  id                INTEGER PRIMARY KEY,
  side              TEXT    NOT NULL CHECK (side IN ('a','b')),
  shard_id          INTEGER NOT NULL,
  stuck_height      INTEGER NOT NULL,
  peer_height_start INTEGER NOT NULL,
  peer_height_end   INTEGER,
  max_block_delay   INTEGER NOT NULL DEFAULT 0,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
CREATE INDEX IF NOT EXISTS stalls_open ON stalls (ended_at, side, shard_id);
`;

/** Columns added after v0.1. Each is applied only when missing, so old databases keep working. */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "info_snapshots", column: "num_shards", ddl: "ALTER TABLE info_snapshots ADD COLUMN num_shards INTEGER" },
  { table: "diffs", column: "shard", ddl: "ALTER TABLE diffs ADD COLUMN shard INTEGER" },
];

type Row = Record<string, unknown>;
const n = (v: unknown): number => Number(v);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const toDiff = (r: Row): DiffRow => ({
  id: n(r.id),
  hash: String(r.hash),
  fid: n(r.fid),
  shard: nn(r.shard),
  msgTimestamp: n(r.msg_timestamp),
  presentOn: r.present_on as Side,
  missingOn: r.missing_on as Side,
  cause: r.cause as Cause,
  note: s(r.note),
  messageJson: String(r.message_json),
  firstSeen: n(r.first_seen),
  lastChecked: nn(r.last_checked),
  attempts: n(r.attempts),
  resolvedAt: nn(r.resolved_at),
});

const toInfo = (r: Row): InfoSnapshot => ({
  side: r.side as Side,
  at: n(r.at),
  reachable: n(r.reachable) === 1,
  maxBlockDelay: nn(r.max_block_delay),
  numShards: nn(r.num_shards),
  numFidRegistrations: nn(r.num_fid_registrations),
  shards: JSON.parse(String(r.shards_json)) as InfoSnapshot["shards"],
  error: s(r.error),
});

const toStall = (r: Row): StallRow => ({
  id: n(r.id),
  side: r.side as Side,
  shardId: n(r.shard_id),
  stuckHeight: n(r.stuck_height),
  peerHeightStart: n(r.peer_height_start),
  peerHeightEnd: nn(r.peer_height_end),
  maxBlockDelay: n(r.max_block_delay),
  startedAt: n(r.started_at),
  endedAt: nn(r.ended_at),
});

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    for (const m of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${m.table})`).all() as Row[];
      if (!cols.some((c) => c.name === m.column)) this.db.exec(m.ddl);
    }
    this.migrateCauseCheck();
  }

  /**
   * SQLite cannot alter a CHECK constraint in place. When an older database's `diffs` table
   * lacks a cause that CAUSES now includes, rebuild the table around the current SCHEMA and
   * copy every row across. Runs once; a current database is left untouched.
   */
  private migrateCauseCheck(): void {
    const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'diffs'`).get() as Row | undefined;
    const sql = String(row?.sql ?? "");
    if (CAUSES.every((c) => sql.includes(`'${c}'`))) return;
    const cols = (this.db.prepare(`PRAGMA table_info(diffs)`).all() as Row[]).map((c) => String(c.name)).join(", ");
    this.db.exec("BEGIN");
    try {
      this.db.exec(`ALTER TABLE diffs RENAME TO diffs_old`);
      // Re-running SCHEMA recreates `diffs` (and its indexes) with the current CHECK.
      this.db.exec(SCHEMA);
      this.db.exec(`INSERT INTO diffs (${cols}) SELECT ${cols} FROM diffs_old`);
      this.db.exec(`DROP TABLE diffs_old`);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  async recordInfo(x: InfoSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO info_snapshots (side, at, reachable, max_block_delay, num_shards, num_fid_registrations, shards_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        x.side,
        x.at,
        x.reachable ? 1 : 0,
        x.maxBlockDelay,
        x.numShards,
        x.numFidRegistrations,
        JSON.stringify(x.shards),
        x.error,
      );
  }

  async latestInfo(side: Side): Promise<InfoSnapshot | null> {
    const r = this.db.prepare(`SELECT * FROM info_snapshots WHERE side = ? ORDER BY at DESC LIMIT 1`).get(side);
    return r === undefined ? null : toInfo(r as Row);
  }

  async recentInfo(side: Side, limit: number): Promise<InfoSnapshot[]> {
    return this.db
      .prepare(`SELECT * FROM info_snapshots WHERE side = ? ORDER BY at DESC LIMIT ?`)
      .all(side, limit)
      .map((r) => toInfo(r as Row));
  }

  async insertDiff(d: NewDiff): Promise<boolean> {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO diffs (hash, fid, shard, msg_timestamp, present_on, missing_on, message_json, first_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.hash, d.fid, d.shard, d.msgTimestamp, d.presentOn, d.missingOn, d.messageJson, d.firstSeen);
    return Number(res.changes) > 0;
  }

  async dueForRecheck(now: number, recheckAfterMs: number, windowMs: number, limit: number): Promise<DiffRow[]> {
    return this.db
      .prepare(
        `SELECT * FROM diffs
         WHERE cause IN ('pending','unexplained')
           AND resolved_at IS NULL
           AND first_seen >= ?
           AND COALESCE(last_checked, first_seen) <= ?
         ORDER BY first_seen ASC
         LIMIT ?`,
      )
      .all(now - windowMs, now - recheckAfterMs, limit)
      .map((r) => toDiff(r as Row));
  }

  async updateVerdict(id: number, cause: Cause, note: string | null, checkedAt: number, resolved: boolean): Promise<void> {
    this.db
      .prepare(
        `UPDATE diffs SET cause = ?, note = ?, last_checked = ?, attempts = attempts + 1, resolved_at = ?
         WHERE id = ?`,
      )
      .run(cause, note, checkedAt, resolved ? checkedAt : null, id);
  }

  async listDiffs(f: DiffFilter): Promise<DiffRow[]> {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.cause !== undefined) {
      where.push("cause = ?");
      args.push(f.cause);
    }
    if (f.fromMs !== undefined) {
      where.push("first_seen >= ?");
      args.push(f.fromMs);
    }
    if (f.toMs !== undefined) {
      where.push("first_seen < ?");
      args.push(f.toMs);
    }
    const sql = `SELECT * FROM diffs ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY first_seen DESC, id DESC LIMIT ?`;
    args.push(f.limit ?? 500);
    return this.db
      .prepare(sql)
      .all(...args)
      .map((r) => toDiff(r as Row));
  }

  async recordScan(r: ScanRun): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO scans (started_at, finished_at, fids_scanned, messages_a, messages_b, new_diffs, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.startedAt, r.finishedAt, r.fidsScanned, r.messagesA, r.messagesB, r.newDiffs, r.errors);
  }

  async openStalls(): Promise<StallRow[]> {
    return this.db
      .prepare(`SELECT * FROM stalls WHERE ended_at IS NULL ORDER BY started_at ASC`)
      .all()
      .map((r) => toStall(r as Row));
  }

  async startStall(x: NewStall): Promise<number> {
    const res = this.db
      .prepare(
        `INSERT INTO stalls (side, shard_id, stuck_height, peer_height_start, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(x.side, x.shardId, x.stuckHeight, x.peerHeightStart, x.startedAt);
    return Number(res.lastInsertRowid);
  }

  async touchStall(id: number, maxBlockDelay: number): Promise<void> {
    this.db.prepare(`UPDATE stalls SET max_block_delay = MAX(max_block_delay, ?) WHERE id = ?`).run(maxBlockDelay, id);
  }

  async endStall(id: number, endedAt: number, peerHeightEnd: number): Promise<void> {
    this.db.prepare(`UPDATE stalls SET ended_at = ?, peer_height_end = ? WHERE id = ?`).run(endedAt, peerHeightEnd, id);
  }

  async listStalls(f: { fromMs?: number; toMs?: number; limit?: number }): Promise<StallRow[]> {
    const where: string[] = [];
    const args: number[] = [];
    if (f.fromMs !== undefined) {
      where.push("started_at >= ?");
      args.push(f.fromMs);
    }
    if (f.toMs !== undefined) {
      where.push("started_at < ?");
      args.push(f.toMs);
    }
    args.push(f.limit ?? 200);
    return this.db
      .prepare(
        `SELECT * FROM stalls ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...args)
      .map((r) => toStall(r as Row));
  }

  async summary(): Promise<Summary> {
    const byCause = Object.fromEntries(CAUSES.map((c) => [c, 0])) as Record<Cause, number>;
    for (const r of this.db.prepare(`SELECT cause, COUNT(*) AS c FROM diffs GROUP BY cause`).all() as Row[]) {
      byCause[r.cause as Cause] = n(r.c);
    }
    const byMissingSide: Record<Side, number> = { a: 0, b: 0 };
    for (const r of this.db
      .prepare(`SELECT missing_on, COUNT(*) AS c FROM diffs WHERE cause = 'unexplained' GROUP BY missing_on`)
      .all() as Row[]) {
      byMissingSide[r.missing_on as Side] = n(r.c);
    }
    const scan = this.db.prepare(`SELECT COUNT(*) AS c, MAX(finished_at) AS last FROM scans`).get() as Row;
    const st = this.db
      .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS open FROM stalls`)
      .get() as Row;
    return {
      byCause,
      byMissingSide,
      scans: n(scan.c),
      lastScanAt: nn(scan.last),
      openStalls: n(st.open ?? 0),
      totalStalls: n(st.total),
    };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
