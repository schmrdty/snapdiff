import { mkdirSync, writeFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { loadConfig } from "./config.js";
import { SqliteStore } from "./store/sqlite.js";
import type { Store } from "./store/store.js";
import { CAUSES, type Cause } from "./types.js";

/** Deterministic JSON: sorted keys, no whitespace. Same data always yields the same hash. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export async function buildReport(store: Store, labels: { a: string; b: string }, dayUtc: string) {
  const from = Date.parse(`${dayUtc}T00:00:00Z`);
  if (Number.isNaN(from)) throw new Error(`Bad date "${dayUtc}", expected YYYY-MM-DD`);
  const to = from + 86_400_000;
  const [rows, stalls] = await Promise.all([
    store.listDiffs({ fromMs: from, toMs: to, limit: 1_000_000 }),
    store.listStalls({ fromMs: from, toMs: to, limit: 100_000 }),
  ]);
  const counts = Object.fromEntries(CAUSES.map((c) => [c, 0])) as Record<Cause, number>;
  for (const r of rows) counts[r.cause]++;
  const report = {
    schema: "snapdiff.report.v2",
    day: dayUtc,
    nodes: labels,
    counts,
    stalls: stalls
      .map((s) => ({
        node: s.side === "a" ? labels.a : labels.b,
        shardId: s.shardId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        stuckHeight: s.stuckHeight,
        peerHeightStart: s.peerHeightStart,
        peerHeightEnd: s.peerHeightEnd,
        maxBlockDelay: s.maxBlockDelay,
      }))
      .sort((x, y) => x.startedAt - y.startedAt),
    unexplained: rows
      .filter((r) => r.cause === "unexplained")
      .map((r) => ({ hash: r.hash, fid: r.fid, shard: r.shard, msgTimestamp: r.msgTimestamp, presentOn: r.presentOn, missingOn: r.missingOn, firstSeen: r.firstSeen }))
      .sort((x, y) => (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0)),
  };
  const json = canonicalJson(report);
  return { report, json, hash: keccak256(toHex(json)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const day = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const store = new SqliteStore(cfg.dbPath);
  const { json, hash, report } = await buildReport(store, { a: cfg.a.label, b: cfg.b.label }, day);
  await store.close();
  mkdirSync("reports", { recursive: true });
  const path = `reports/${day}.json`;
  writeFileSync(path, json);
  console.log(`report:      ${path}`);
  console.log(`counts:      ${JSON.stringify(report.counts)}`);
  console.log(`stalls:      ${report.stalls.length}`);
  console.log(`keccak256:   ${hash}`);
  console.log(`Commit this hash onchain with your attestation CLI to make the report tamper-evident.`);
}
