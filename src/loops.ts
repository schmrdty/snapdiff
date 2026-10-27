import type { Config } from "./config.js";
import type { HubClient } from "./hub.js";
import type { Store } from "./store/store.js";
import type { HubMessage, ScanRun, Side } from "./types.js";
import { classify, diffByHash, toNewDiff } from "./classify.js";
import { shardForFid } from "./shard.js";
import { detectStalls, shardBehind } from "./stall.js";

export interface Deps {
  cfg: Config;
  store: Store;
  hubs: Record<Side, HubClient>;
  log: (msg: string) => void;
  now?: () => number;
  random?: () => number;
}

const clock = (d: Deps) => (d.now ?? Date.now)();

async function pool<T>(items: readonly T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
}

/* Loop 1: liveness, plus the shard-stall detector. */
export async function pollInfo(d: Deps): Promise<void> {
  const [a, b] = await Promise.all([d.hubs.a.info(), d.hubs.b.info()]);
  for (const snap of [a, b]) {
    await d.store.recordInfo(snap);
    if (!snap.reachable) d.log(`[info] ${snap.side} unreachable: ${snap.error ?? "unknown"}`);
  }
  await updateStalls(d, a, b);
}

/**
 * Opens a stall record when one node's shard stops while the other's keeps going, keeps the
 * record's worst delay current, and closes it when the shard catches up. Each stall is a
 * timestamped event: side, shard, height it stuck at, how far the peer got, start, end.
 */
export async function updateStalls(d: Deps, a: Awaited<ReturnType<HubClient["info"]>>, b: typeof a): Promise<void> {
  const now = clock(d);
  const signals = detectStalls(a, b, d.cfg.behindBlockDelay);
  const open = await d.store.openStalls();
  const key = (side: Side, shardId: number) => `${side}:${shardId}`;
  const seen = new Set<string>();

  for (const s of signals) {
    seen.add(key(s.side, s.shardId));
    const existing = open.find((o) => o.side === s.side && o.shardId === s.shardId);
    if (existing !== undefined) {
      await d.store.touchStall(existing.id, s.blockDelay);
      continue;
    }
    const id = await d.store.startStall({
      side: s.side,
      shardId: s.shardId,
      stuckHeight: s.stuckHeight,
      peerHeightStart: s.peerHeight,
      startedAt: now,
    });
    await d.store.touchStall(id, s.blockDelay);
    d.log(
      `[stall] START ${d.cfg[s.side].label} shard ${s.shardId} stuck at height ${s.stuckHeight} (delay ${s.blockDelay}s, peer at ${s.peerHeight})`,
    );
  }

  // Close stalls that are no longer signalled, but only when both nodes answered. An
  // unreachable node is not evidence that its shard recovered.
  if (a.reachable && b.reachable) {
    for (const o of open) {
      if (seen.has(key(o.side, o.shardId))) continue;
      const peer = o.side === "a" ? b : a;
      const peerHeight = peer.shards.find((x) => x.shardId === o.shardId)?.maxHeight ?? o.peerHeightStart;
      await d.store.endStall(o.id, now, peerHeight);
      const mins = Math.round((now - o.startedAt) / 60_000);
      d.log(`[stall] END ${d.cfg[o.side].label} shard ${o.shardId} after ${mins}m (peer now at ${peerHeight})`);
    }
  }
}

export async function pickFids(d: Deps): Promise<number[]> {
  const fids = new Set(d.cfg.watchFids);
  let upper = d.cfg.maxFid;
  if (upper <= 0) {
    const [ia, ib] = await Promise.all([d.store.latestInfo("a"), d.store.latestInfo("b")]);
    const vals = [ia?.numFidRegistrations, ib?.numFidRegistrations].filter((v): v is number => typeof v === "number" && v > 0);
    upper = vals.length > 0 ? Math.min(...vals) : 0;
  }
  const rnd = d.random ?? Math.random;
  if (upper > 0) {
    let guard = 0;
    const target = fids.size + d.cfg.sampleSize;
    while (fids.size < target && guard++ < d.cfg.sampleSize * 10) fids.add(1 + Math.floor(rnd() * upper));
  }
  return [...fids];
}

/* Loop 2: scan sampled FIDs on both nodes and record hash-level differences. */
export async function scanOnce(d: Deps): Promise<ScanRun> {
  const startedAt = clock(d);
  const nowSec = Math.floor(startedAt / 1000);
  const start = nowSec - d.cfg.lookbackHours * 3600;
  const stop = nowSec - d.cfg.graceSeconds;
  const fids = await pickFids(d);
  const run: ScanRun = { startedAt, finishedAt: 0, fidsScanned: 0, messagesA: 0, messagesB: 0, newDiffs: 0, errors: 0 };

  // Data-shard count comes from /v1/info. If the two nodes disagree, shard tagging is unsafe.
  const [ia, ib] = await Promise.all([d.store.latestInfo("a"), d.store.latestInfo("b")]);
  const counts = [ia?.numShards, ib?.numShards].filter((v): v is number => typeof v === "number");
  const numShards = counts.length > 0 && counts.every((c) => c === counts[0]) ? (counts[0] as number) : null;
  if (numShards === null) d.log(`[scan] numShards unknown or mismatched (${String(ia?.numShards)} vs ${String(ib?.numShards)}); diffs get no shard tag`);
  const shardOf = (fid: number): number | null => (numShards === null ? null : shardForFid(fid, numShards));

  await pool(fids, d.cfg.concurrency, async (fid) => {
    let a: HubMessage[];
    let b: HubMessage[];
    try {
      [a, b] = await Promise.all([
        d.hubs.a.castsByFid(fid, start, stop, d.cfg.maxPagesPerFid),
        d.hubs.b.castsByFid(fid, start, stop, d.cfg.maxPagesPerFid),
      ]);
    } catch (e) {
      // Skip the FID entirely. A one-sided fetch failure must never look like a missing message.
      run.errors++;
      d.log(`[scan] fid ${fid} skipped: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    run.fidsScanned++;
    run.messagesA += a.length;
    run.messagesB += b.length;
    const { onlyA, onlyB } = diffByHash(a, b);
    const now = clock(d);
    const shard = shardOf(fid);
    for (const m of onlyA) if (await d.store.insertDiff(toNewDiff(m, "a", now, shard))) run.newDiffs++;
    for (const m of onlyB) if (await d.store.insertDiff(toNewDiff(m, "b", now, shard))) run.newDiffs++;
  });

  run.finishedAt = clock(d);
  await d.store.recordScan(run);
  d.log(
    `[scan] ${run.fidsScanned}/${fids.length} fids, ${run.messagesA}/${run.messagesB} casts, ${run.newDiffs} new diffs, ${run.errors} errors`,
  );
  return run;
}

/* Loop 3: recheck open diffs against the missing side and classify by cause. */
export async function recheckOnce(d: Deps): Promise<number> {
  const now = clock(d);
  const due = await d.store.dueForRecheck(now, d.cfg.recheckAfterMs, d.cfg.recheckWindowMs, 200);
  const latest: Record<Side, Awaited<ReturnType<Store["latestInfo"]>>> = {
    a: await d.store.latestInfo("a"),
    b: await d.store.latestInfo("b"),
  };

  // FID registrations don't change within a run, so ask each node once per FID.
  const fidKnown: Record<Side, Map<number, boolean | null>> = { a: new Map(), b: new Map() };
  const knowsFid = async (side: Side, fid: number): Promise<boolean | null> => {
    const cached = fidKnown[side].get(fid);
    if (cached !== undefined) return cached;
    let v: boolean | null;
    try {
      v = await d.hubs[side].knowsFid(fid);
    } catch {
      v = null;
    }
    fidKnown[side].set(fid, v);
    return v;
  };

  for (const row of due) {
    let found: boolean | null;
    try {
      found = await d.hubs[row.missingOn].hasCast(row.fid, row.hash);
    } catch {
      found = null;
    }
    const message = JSON.parse(row.messageJson) as HubMessage;
    const filteredType = d.cfg.relayFilteredTypes.has(message.data.type);
    // Only spend the extra request when it can change the verdict.
    const fidOrigin =
      found === false && !filteredType && d.cfg.fidOriginCheck ? await knowsFid(row.missingOn, row.fid) : undefined;
    // Per-shard gate: a stall on shard 2 must not pause judgement of shard-1 diffs. Falls back
    // to the whole-node check when the diff has no shard tag.
    const v = classify({
      foundOnMissingSide: found,
      missingSideBehind: shardBehind(latest[row.missingOn], row.shard, d.cfg.behindBlockDelay),
      filteredType,
      ...(fidOrigin !== undefined ? { fidKnownOnMissingSide: fidOrigin } : {}),
      message,
      ageMs: now - row.firstSeen,
      unexplainedAfterMs: d.cfg.unexplainedAfterMs,
      rules: { v21TextBytes: d.cfg.v21TextBytes },
    });
    await d.store.updateVerdict(row.id, v.cause, v.note, now, v.final);
    if (v.cause === "unexplained" && row.cause !== "unexplained") {
      d.log(`[recheck] UNEXPLAINED fid=${row.fid} hash=${row.hash} missing on ${row.missingOn}`);
    }
  }
  return due.length;
}

/** setInterval that never overlaps itself and never dies on a thrown error. */
export function every(ms: number, name: string, fn: () => Promise<unknown>, log: (m: string) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      log(`[${name}] error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const t = setInterval(() => void tick(), ms);
  return () => clearInterval(t);
}
