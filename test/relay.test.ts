import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../src/classify.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { HubMessage } from "../src/types.js";

const rules = { v21TextBytes: 1024 };
const msg = (type = "MESSAGE_TYPE_CAST_ADD", body: Record<string, unknown> = { text: "hi" }): HubMessage => ({
  hash: "0x1",
  data: { type, fid: 9, timestamp: 100, castAddBody: body },
});
const base = { foundOnMissingSide: false as const, missingSideBehind: false, ageMs: 60 * 60_000, unexplainedAfterMs: 30 * 60_000, rules };

test("relay_filtered: filtered type wins over everything except arrival", () => {
  const chained = msg("MESSAGE_TYPE_CHANNEL_PIN", { text: "x", chain: {} });
  assert.equal(classify({ ...base, foundOnMissingSide: true, filteredType: true, message: chained }).cause, "sync_lag");
  const v = classify({ ...base, filteredType: true, message: chained });
  assert.equal(v.cause, "relay_filtered");
  assert.equal(v.final, true);
  assert.match(v.note ?? "", /MESSAGE_TYPE_CHANNEL_PIN/);
});

test("relay_filtered: fid unknown on the missing side; null means pending; undefined skips the check", () => {
  const plain = msg();
  const v = classify({ ...base, fidKnownOnMissingSide: false, message: plain });
  assert.equal(v.cause, "relay_filtered");
  assert.match(v.note ?? "", /fid 9 is not registered/);
  assert.equal(classify({ ...base, fidKnownOnMissingSide: null, message: plain }).cause, "pending");
  assert.equal(classify({ ...base, fidKnownOnMissingSide: true, message: plain }).cause, "unexplained");
  assert.equal(classify({ ...base, message: plain }).cause, "unexplained", "check disabled: falls through");
  // A known fid with a V22 cast is still version_rule, not relay_filtered.
  assert.equal(classify({ ...base, fidKnownOnMissingSide: true, message: msg("MESSAGE_TYPE_CAST_ADD", { text: "x", chain: {} }) }).cause, "version_rule");
});

test("sqlite: an older database whose CHECK lacks relay_filtered is rebuilt with rows intact", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "snapdiff-")), "old.db");
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE diffs (
      id INTEGER PRIMARY KEY, hash TEXT NOT NULL, fid INTEGER NOT NULL, shard INTEGER, msg_timestamp INTEGER NOT NULL,
      present_on TEXT NOT NULL CHECK (present_on IN ('a','b')), missing_on TEXT NOT NULL CHECK (missing_on IN ('a','b')),
      cause TEXT NOT NULL DEFAULT 'pending' CHECK (cause IN ('pending','sync_lag','version_rule','unexplained')),
      note TEXT, message_json TEXT NOT NULL, first_seen INTEGER NOT NULL, last_checked INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
      resolved_at INTEGER, UNIQUE (hash, missing_on));
    INSERT INTO diffs (hash, fid, shard, msg_timestamp, present_on, missing_on, cause, message_json, first_seen, attempts)
      VALUES ('0xold', 7, 1, 1, 'a', 'b', 'unexplained', '{}', 5, 3);
  `);
  raw.close();

  const s = new SqliteStore(path);
  const rows = await s.listDiffs({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cause, "unexplained");
  assert.equal(rows[0]!.attempts, 3, "row data survived the rebuild");
  await s.updateVerdict(rows[0]!.id, "relay_filtered", "fid 7 is not registered on the missing side", 10, true);
  assert.equal((await s.listDiffs({}))[0]!.cause, "relay_filtered", "new cause accepted after migration");
  assert.equal((await s.summary()).byCause.relay_filtered, 1);
  await s.close();

  // Idempotent: opening again does not rebuild or lose anything.
  const s2 = new SqliteStore(path);
  assert.equal((await s2.listDiffs({})).length, 1);
  await s2.close();
});
