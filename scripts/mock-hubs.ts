/**
 * Two fake hubs for trying snapdiff without real nodes.
 *   npm run mock     -> "snapchain" on :3381, "hypersnap" on :4381
 *
 * Seeded scenarios, per FID 1..5:
 *   - shared casts (no diff)
 *   - one cast only on A that shows up on B after LAG_SEC  -> sync_lag
 *   - one V22 chained cast only on A                       -> version_rule
 *   - one plain cast only on B, never on A                 -> unexplained
 * FID 6 is registered on B only (an "on network" fid). Its cast is on B, never on A, and A has
 * no ID registration for it                                 -> relay_filtered
 *
 * Shard stall scenario (B only): from STALL_START_SEC to STALL_END_SEC after launch, B's shard 2
 * stops advancing. Its maxHeight freezes and blockDelay climbs. Shard 1 keeps going. Set
 * STALL_START_SEC=0 STALL_END_SEC=0 to disable.
 *
 * Heights advance one block per second from a fixed base, so the two hubs agree unless stalled.
 * Shard routing uses the real SHA256 rule, so /v1/events reports the correct shardIndex per fid.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { FARCASTER_EPOCH } from "../src/hub.js";
import { shardForFid } from "../src/shard.js";
import type { HubMessage } from "../src/types.js";

const LAG_SEC = Number(process.env.LAG_SEC ?? 20);
const STALL_START_SEC = Number(process.env.STALL_START_SEC ?? 30);
const STALL_END_SEC = Number(process.env.STALL_END_SEC ?? 150);
const NUM_SHARDS = 2;
const BASE_HEIGHT = 1_900_000;
const started = Date.now();
const elapsedSec = () => (Date.now() - started) / 1000;
const nowFc = () => Math.floor(Date.now() / 1000) - FARCASTER_EPOCH;

const mk = (fid: number, text: string, ageSec: number, extra: Record<string, unknown> = {}): HubMessage => ({
  hash: `0x${createHash("sha256").update(`${fid}:${text}`).digest("hex").slice(0, 40)}`,
  data: { type: "MESSAGE_TYPE_CAST_ADD", fid, timestamp: nowFc() - ageSec, network: "FARCASTER_NETWORK_MAINNET", castAddBody: { text, ...extra } },
});

const shared: HubMessage[] = [];
const lagged: HubMessage[] = [];
const onlyA: HubMessage[] = [];
const onlyB: HubMessage[] = [];
for (let fid = 1; fid <= 5; fid++) {
  for (let i = 0; i < 3; i++) shared.push(mk(fid, `shared ${i}`, 3600 + i));
  lagged.push(mk(fid, "late arrival", 600));
  onlyA.push(mk(fid, "chained cast", 900, { formatVersion: 1, chain: { position: 1 } }));
  onlyB.push(mk(fid, "plain cast A never got", 1200));
}
const ON_NETWORK_FID = 6;
onlyB.push(mk(ON_NETWORK_FID, "cast from a hypersnap-only fid", 800));

/** Which fids each node has an ID registration for. */
const registered = (side: "a" | "b", fid: number): boolean => (fid >= 1 && fid <= 5) || (side === "b" && fid === ON_NETWORK_FID);

const store = (side: "a" | "b"): HubMessage[] => {
  const lagDone = elapsedSec() > LAG_SEC;
  return side === "a" ? [...shared, ...lagged, ...onlyA] : [...shared, ...(lagDone ? lagged : []), ...onlyB];
};

/** B's shard 2 is frozen during the stall window. */
const stalled = (side: "a" | "b", shardId: number): boolean =>
  side === "b" && shardId === 2 && STALL_END_SEC > STALL_START_SEC && elapsedSec() >= STALL_START_SEC && elapsedSec() < STALL_END_SEC;

const shardInfo = (side: "a" | "b", shardId: number) => {
  const live = Math.floor(elapsedSec());
  if (stalled(side, shardId)) {
    return { shardId, maxHeight: BASE_HEIGHT + shardId + STALL_START_SEC, blockDelay: 3 + Math.floor(elapsedSec() - STALL_START_SEC), mempoolSize: 0 };
  }
  return { shardId, maxHeight: BASE_HEIGHT + shardId + live, blockDelay: 3, mempoolSize: 0 };
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const handler = (side: "a" | "b") => (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://x");
  const fid = Number(url.searchParams.get("fid"));
  if (url.pathname === "/v1/info") {
    return send(res, 200, {
      dbStats: { numMessages: 1000, numFidRegistrations: side === "b" ? 6 : 5, approxSize: 1 },
      numShards: NUM_SHARDS,
      shardInfos: [0, 1, 2].map((id) => shardInfo(side, id)),
    });
  }
  if (url.pathname === "/v1/castsByFid") {
    const start = Number(url.searchParams.get("startTimestamp") ?? 0);
    const stop = Number(url.searchParams.get("stopTimestamp") ?? Number.MAX_SAFE_INTEGER);
    const messages = store(side).filter((m) => m.data.fid === fid && m.data.timestamp >= start && m.data.timestamp <= stop);
    return send(res, 200, { messages, nextPageToken: "" });
  }
  if (url.pathname === "/v1/castById") {
    const hash = (url.searchParams.get("hash") ?? "").toLowerCase();
    const m = store(side).find((x) => x.data.fid === fid && x.hash === hash);
    return m ? send(res, 200, m) : send(res, 404, { errCode: "not_found", details: "message not found" });
  }
  if (url.pathname === "/v1/onChainEventsByFid") {
    if (url.searchParams.get("event_type") !== "EVENT_TYPE_ID_REGISTER") return send(res, 200, { events: [], nextPageToken: "" });
    const events = registered(side, fid)
      ? [{ type: "EVENT_TYPE_ID_REGISTER", fid, blockNumber: 1, idRegisterEventBody: { to: "0x00", eventType: "ID_REGISTER_EVENT_TYPE_REGISTER" } }]
      : [];
    return send(res, 200, { events, nextPageToken: "" });
  }
  if (url.pathname === "/v1/events") {
    const shardIndex = Number(url.searchParams.get("shard_index") ?? 1);
    const events = store(side)
      .filter((m) => shardForFid(m.data.fid, NUM_SHARDS) === shardIndex)
      .map((m, i) => ({ type: "HUB_EVENT_TYPE_MERGE_MESSAGE", id: 1000 + i, blockNumber: BASE_HEIGHT, shardIndex, mergeMessageBody: { message: m } }));
    return send(res, 200, { events, nextPageToken: "" });
  }
  send(res, 404, { errCode: "not_found", details: "no route" });
};

const pa = Number(process.env.MOCK_A_PORT ?? 3381);
const pb = Number(process.env.MOCK_B_PORT ?? 4381);
createServer(handler("a")).listen(pa, () => console.log(`mock snapchain on :${pa}`));
createServer(handler("b")).listen(pb, () =>
  console.log(`mock hypersnap on :${pb} (lagged casts arrive after ${LAG_SEC}s; shard 2 stalls from ${STALL_START_SEC}s to ${STALL_END_SEC}s)`),
);
