import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, diffByHash, versionRuleReason } from "../src/classify.js";
import { canonicalJson } from "../src/report.js";
import { SqliteStore } from "../src/store/sqlite.js";
import type { HubMessage } from "../src/types.js";

const rules = { v21TextBytes: 1024 };
const msg = (hash: string, body: Record<string, unknown> = { text: "hi" }): HubMessage => ({
  hash,
  data: { type: "MESSAGE_TYPE_CAST_ADD", fid: 1, timestamp: 100, castAddBody: body },
});
const base = { missingSideBehind: false, ageMs: 60 * 60_000, unexplainedAfterMs: 30 * 60_000, rules };

test("diffByHash is case-insensitive and symmetric", () => {
  const { onlyA, onlyB } = diffByHash([msg("0xAA"), msg("0xbb")], [msg("0xaa"), msg("0xcc")]);
  assert.deepEqual(onlyA.map((m) => m.hash), ["0xbb"]);
  assert.deepEqual(onlyB.map((m) => m.hash), ["0xcc"]);
});

test("V22 fields and long casts are version_rule", () => {
  assert.match(versionRuleReason(msg("0x1", { text: "x", chain: { p: 1 } }), rules) ?? "", /V22/);
  assert.match(versionRuleReason(msg("0x1", { text: "x", formatVersion: 1 }), rules) ?? "", /V22/);
  assert.equal(versionRuleReason(msg("0x1", { text: "x", formatVersion: 0 }), rules), null);
  assert.match(versionRuleReason(msg("0x1", { text: "é".repeat(600) }), rules) ?? "", /V21: 1200-byte/);
  assert.equal(versionRuleReason(msg("0x1", { text: "short" }), rules), null);
});

test("classification order", () => {
  const plain = msg("0x1");
  const chained = msg("0x2", { text: "x", chain: {} });
  assert.equal(classify({ ...base, foundOnMissingSide: true, message: chained }).cause, "sync_lag");
  assert.equal(classify({ ...base, foundOnMissingSide: null, message: plain }).cause, "pending");
  assert.equal(classify({ ...base, foundOnMissingSide: false, message: chained }).cause, "version_rule");
  assert.equal(classify({ ...base, foundOnMissingSide: false, missingSideBehind: true, message: plain }).cause, "pending");
  assert.equal(classify({ ...base, foundOnMissingSide: false, ageMs: 60_000, message: plain }).cause, "pending");
  const u = classify({ ...base, foundOnMissingSide: false, message: plain });
  assert.equal(u.cause, "unexplained");
  assert.equal(u.final, false, "unexplained stays open so late arrivals can flip to sync_lag");
});

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("sqlite store: dedupe, recheck window, verdict", async () => {
  const s = new SqliteStore(":memory:");
  const d = { hash: "0xaa", fid: 1, shard: 2, msgTimestamp: 1, presentOn: "a" as const, missingOn: "b" as const, messageJson: "{}", firstSeen: 1000 };
  assert.equal(await s.insertDiff(d), true);
  assert.equal(await s.insertDiff(d), false);
  assert.equal((await s.dueForRecheck(1500, 1000, 10_000, 10)).length, 0, "not due yet");
  const due = await s.dueForRecheck(2500, 1000, 10_000, 10);
  assert.equal(due.length, 1);
  await s.updateVerdict(due[0]!.id, "sync_lag", "arrived", 2500, true);
  assert.equal((await s.dueForRecheck(99_000, 0, 1e9, 10)).length, 0, "resolved rows drop out");
  assert.equal((await s.summary()).byCause.sync_lag, 1);
  await s.close();
});
