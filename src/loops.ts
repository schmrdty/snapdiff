import type { Config } from "./config.js";
import type { HubClient } from "./hub.js";
import type { Store } from "./store/store.js";
import type { HubMessage, InfoSnapshot, ScanRun, Side } from "./types.js";
import { classify, scopeOf, toNewDiff } from "./classify.js";
import { shardForFid } from "./shard.js";
import { detectStalls, shardBehind } from "./stall.js";

export interface Deps {
  cfg: Config;
  store: Store;
  /** One client per configured node, keyed by label. */
  hubs: Record<Side, HubClient>;
  log: (msg: string) => void;
  now?: () => number;
  random?: () => number;
}

const clock = (d: Deps) => (d.now ?? Date.now)();
const labels = (d: Deps): Side[] => d.cfg.nodes.map((n) => n.label);
const hub = (d: Deps, side: Side): HubClient => {
  const h = d.hubs[side];
  if (h === undefined) throw new Error(`no hub client for node "${side}"`);
  return h;
};

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

/* Loop 1: liveness for every node, plus the shard-stall detector. */
export async function pollInfo(d: Deps): Promise<void> {
  const infos = await Promise.all(labels(d).map((l) => hub(d, l).info()));
  for (const snap of infos) {
    await d.store.recordInfo(snap);
    if (!snap.reachable) d.log(`[info] ${snap.side} unreachable: ${snap.error ?? "unknown"}`);
  }
  await updateStalls(d, infos);
}

/**
 * Opens a stall record when one node's shard stops while a healthy peer's keeps going, keeps
 * the record's worst delay current, and closes it when the shard catches up. Each stall is a
 * timestamped event: node, shard, height it stuck at, which peer it was measured against and
 * how far that peer got, start, end.
 */
export async function updateStalls(d: Deps, infos: ReadonlyArray<InfoSnapshot | null>): Promise<void> {
  const now = clock(d);
  const signals = detectStalls(infos, d.cfg.behindBlockDelay);
  const open = await d.store.openStalls();
  const key = (side: Side, shardId: number) => `${side}:${shardId}`;
  const seen = new Set<string>();
  const byLabel = new Map(infos.filter((i): i is InfoSnapshot => i !== null).map((i) => [i.side, i]));

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
      peer: s.peer,
      peerHeightStart: s.peerHeight,
      startedAt: now,
    });
    await d.store.touchStall(id, s.blockDelay);
    d.log(`[stall] START ${s.side} shard ${s.shardId} stuck at height ${s.stuckHeight} (delay ${s.blockDelay}s, ${s.peer} at ${s.peerHeight})`);
  }

  // Close a stall only when the stalled node and at least one other node answered this
  // tick. An unreachable node is not evidence that its shard recovered.
  const reachableCount = [...byLabel.values()].filter((i) => i.reachable).length;
  for (const o of open) {
    if (seen.has(key(o.side, o.shardId))) continue;
    const me = byLabel.get(o.side);
    if (me === undefined || !me.reachable || reachableCount < 2) continue;
    const peerInfo = (o.peer !== null ? byLabel.get(o.peer) : undefined) ?? [...byLabel.values()].find((i) => i.side !== o.side && i.reachable);
    const peerHeight = peerInfo?.shards.find((x) => x.shardId === o.shardId)?.maxHeight ?? o.peerHeightStart;
    await d.store.endStall(o.id, now, peerHeight);
    const mins = Math.round((now - o.startedAt) / 60_000);
    d.log(`[stall] END ${o.side} shard ${o.shardId} after ${mins}m (${peerInfo?.side ?? "peer"} now at ${peerHeight})`);
  }
}

export async function pickFids(d: Deps): Promise<number[]> {
  const fids = new Set(d.cfg.watchFids);
  let upper = d.cfg.maxFid;
  if (upper <= 0) {
    const infos = await Promise.all(labels(d).map((l) => d.store.latestInfo(l)));
    const vals = infos.map((i) => i?.numFidRegistrations).filter((v): v is number => typeof v === "number" && v > 0);
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

/*
 * Loop 2: scan sampled FIDs on every node and record hash-level differences. For each FID the
 * casts of every node that answered are merged into one presence picture (hash -> nodes that
 * have it); every answering node that lacks a hash gets one diff row, scoped by whether a
 * peer on its own network has the cast. A node whose fetch fails is unknown for that FID: it
 * gets no rows, is not counted as a peer, and its error is counted. Fewer than two answers
 * skips the FID. A fetch failure must never look like a missing message.
 */
export async function scanOnce(d: Deps): Promise<ScanRun> {
  const startedAt = clock(d);
  const nowSec = Math.floor(startedAt / 1000);
  const start = nowSec - d.cfg.lookbackHours * 3600;
  const stop = nowSec - d.cfg.graceSeconds;
  const fids = await pickFids(d);
  const ref = d.cfg.reference;
  // Per-network references, tried for presentOn after the reference (network order).
  const refs = Object.values(d.cfg.references ?? {});
  const networkOf = (l: Side): string => d.cfg.nodes.find((n) => n.label === l)?.network ?? "unknown";
  const run: ScanRun = {
    startedAt,
    finishedAt: 0,
    fidsScanned: 0,
    messagesByNode: Object.fromEntries(labels(d).map((l) => [l, 0])),
    reference: ref,
    newDiffs: 0,
    errors: 0,
  };

  // Data-shard count comes from /v1/info. If the nodes disagree, shard tagging is unsafe.
  const infos = await Promise.all(labels(d).map((l) => d.store.latestInfo(l)));
  const counts = infos.map((i) => i?.numShards).filter((v): v is number => typeof v === "number");
  const numShards = counts.length > 0 && counts.every((c) => c === counts[0]) ? (counts[0] as number) : null;
  if (numShards === null) d.log(`[scan] numShards unknown or mismatched (${infos.map((i) => String(i?.numShards)).join(" vs ")}); diffs get no shard tag`);
  const shardOf = (fid: number): number | null => (numShards === null ? null : shardForFid(fid, numShards));

  await pool(fids, d.cfg.concurrency, async (fid) => {
    const results = await Promise.all(
      labels(d).map(async (l): Promise<[Side, HubMessage[] | null]> => {
        try {
          return [l, await hub(d, l).castsByFid(fid, start, stop, d.cfg.maxPagesPerFid)];
        } catch (e) {
          run.errors++;
          d.log(`[scan] fid ${fid} on ${l} skipped: ${e instanceof Error ? e.message : String(e)}`);
          return [l, null];
        }
      }),
    );
    const answered = results.filter((r): r is [Side, HubMessage[]] => r[1] !== null);
    if (answered.length < 2) return;
    run.fidsScanned++;
    const now = clock(d);
    const shard = shardOf(fid);
    // Presence picture: lowercase hash -> one message plus the answering nodes that have it.
    const picture = new Map<string, { msg: HubMessage; on: Side[] }>();
    for (const [l, msgs] of answered) {
      run.messagesByNode[l] = (run.messagesByNode[l] ?? 0) + msgs.length;
      for (const m of msgs) {
        const h = m.hash.toLowerCase();
        const e = picture.get(h);
        if (e === undefined) picture.set(h, { msg: m, on: [l] });
        else if (!e.on.includes(l)) e.on.push(l);
      }
    }
    for (const { msg, on } of picture.values()) {
      for (const [l] of answered) {
        if (on.includes(l)) continue;
        const placement = { presentNodes: on, missingOn: l, scope: scopeOf(l, on, networkOf), missingNetwork: networkOf(l), reference: ref, references: refs };
        if (await d.store.insertDiff(toNewDiff(msg, placement, now, shard))) run.newDiffs++;
      }
    }
  });

  run.finishedAt = clock(d);
  await d.store.recordScan(run);
  const perNode = labels(d).map((l) => `${l}=${run.messagesByNode[l] ?? 0}`).join(" ");
  d.log(`[scan] ${run.fidsScanned}/${fids.length} fids, casts ${perNode}, ${run.newDiffs} new diffs, ${run.errors} errors`);
  return run;
}

/* Loop 3: recheck open diffs against the node they are missing on and classify by cause. */
export async function recheckOnce(d: Deps): Promise<number> {
  const now = clock(d);
  const due = await d.store.dueForRecheck(now, d.cfg.recheckAfterMs, d.cfg.recheckWindowMs, 200);
  const latest = new Map<Side, InfoSnapshot | null>();
  for (const l of labels(d)) latest.set(l, await d.store.latestInfo(l));

  // FID registrations don't change within a run, so ask each node once per FID.
  const fidKnown = new Map<string, boolean | null>();
  const knowsFid = async (side: Side, fid: number): Promise<boolean | null> => {
    const k = `${side}:${fid}`;
    const cached = fidKnown.get(k);
    if (cached !== undefined) return cached;
    let v: boolean | null;
    try {
      v = await hub(d, side).knowsFid(fid);
    } catch {
      v = null;
    }
    fidKnown.set(k, v);
    return v;
  };

  for (const row of due) {
    if (d.hubs[row.missingOn] === undefined) continue; // a node that was removed from config; leave its rows alone
    let found: boolean | null;
    try {
      found = await hub(d, row.missingOn).hasCast(row.fid, row.hash);
    } catch {
      found = null;
    }
    const message = JSON.parse(row.messageJson) as HubMessage;
    const filteredType = d.cfg.relayFilteredTypes.has(message.data.type);
    // Only spend the extra request when it can change the verdict.
    const fidOrigin = found === false && !filteredType && d.cfg.fidOriginCheck ? await knowsFid(row.missingOn, row.fid) : undefined;
    // Per-shard gate: a stall on shard 2 must not pause judgement of shard-1 diffs. Falls back
    // to the whole-node check when the diff has no shard tag.
    const v = classify({
      foundOnMissingSide: found,
      missingSideBehind: shardBehind(latest.get(row.missingOn) ?? null, row.shard, d.cfg.behindBlockDelay),
      filteredType,
      ...(fidOrigin !== undefined ? { fidKnownOnMissingSide: fidOrigin } : {}),
      message,
      ageMs: now - row.firstSeen,
      unexplainedAfterMs: d.cfg.unexplainedAfterMs,
      rules: { v21TextBytes: d.cfg.v21TextBytes },
    });
    await d.store.updateVerdict(row.id, v.cause, v.note, now, v.final);
    if (v.cause === "unexplained" && row.cause !== "unexplained") {
      d.log(`[recheck] UNEXPLAINED fid=${row.fid} hash=${row.hash} present on ${row.presentNodes.length > 0 ? row.presentNodes.join(",") : row.presentOn}, missing on ${row.missingOn} (scope ${row.scope ?? "unknown"})`);
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
