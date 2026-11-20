// Peer view of a node, from /v1/currentPeers. /v1/info says whether a node's heights move;
// the peer view says who it is connected to, which of those are validators, which validators
// of the current set it is NOT connected to, and whether it is itself a validator. That is the
// question a client or bot asks before switching nodes (Ryan, 2026-11-19).
//
// Until 2026-11-20 this read /v1/mesh, which classifies validators for us but sits behind
// admin_rpc_auth and is closed on some nodes (haatz). currentPeers is the ordinary API and
// stays open, so snapdiff classifies peers itself: the consensus key is derived from the peer
// id (src/validators.ts) and looked up in the network's validators file. The node's own peer
// id comes from /v1/info, which the hub already polls.
//
// Safety contract, same as src/testnet-feed.ts: nothing from a response reaches the page or
// the API unless it matches a fixed shape. Peer ids match PEER_ID_RE, keys are derived (never
// read as text) and only their first 8 characters are kept, counts are checked integers, and
// failures are fixed phrases. Addresses, versions and capabilities are never read: snapdiff
// shows who is connected, not a map of where the validators live.
import type { HubClient } from "./hub.js";
import type { Side } from "./types.js";
import { keyFromPeerId, type ResolvedSets } from "./validators.js";

export const PEER_ID_RE = /^12D3KooW[1-9A-HJ-NP-Za-km-z]{44}$/;
/** Validator rows kept per node; the counts cover every peer up to MESH_MAX_SCAN. */
export const MESH_MAX_PEERS = 64;
/** Peers examined per response; a hostile body cannot make the summarizer work past this. */
export const MESH_MAX_SCAN = 5000;

export type MeshState = "open" | "closed" | "absent" | "unreachable";

export interface MeshPeer {
  peerId: string;
  /** First 8 hex characters of the consensus key derived from the peer id. */
  keyPrefix: string;
  /** In the current set. */
  validator: boolean;
  /** Height at which a next-set key joins; null when already current. */
  joinsAt: number | null;
  /** Always true in this view: currentPeers lists live connections only. */
  connected: true;
}

export interface MeshSelf {
  /** From the node's own /v1/info; null until the first successful info read. */
  peerId: string | null;
  keyPrefix: string | null;
  /** This node's key is in the current set. */
  validator: boolean;
  /** Height at which this node's key joins the set; null when current or never. */
  joinsAt: number | null;
}

export interface MeshSummary {
  side: Side;
  /** Unix ms of the read. */
  at: number;
  state: MeshState;
  /** Fixed phrase when state is not open; null when open. */
  error: string | null;
  /** True when the answer came from a fallback provider (possibly another machine): the page says so and never names a node from it. */
  fallback: boolean;
  /** False when no validators file is configured or fetched for this network: rows are peers only. */
  setKnown: boolean;
  self: MeshSelf | null;
  /** total: every well-formed peer; validators: current-set members among them; setSize: the current set (null when unknown). */
  peers: { total: number; validators: number; setSize: number | null };
  /** Current-set and next-set validators among the peers, current first, then by key prefix. */
  validators: MeshPeer[];
  /** Key prefixes of current-set validators this node is not connected to (its own key excluded). */
  missing: string[];
}

export interface PeerContext {
  selfPeerId: string | null;
  sets: ResolvedSets | null;
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const EMPTY = { total: 0, validators: 0, setSize: null as number | null };

/** A summary from one currentPeers response. `status` 0 means no answer at all. */
export function summarizePeers(side: Side, status: number, body: unknown, at: number, fallback: boolean, ctx: PeerContext): MeshSummary {
  const sets = ctx.sets;
  const selfKey = ctx.selfPeerId === null ? null : keyFromPeerId(ctx.selfPeerId);
  const selfPrefix = selfKey === null ? null : selfKey.slice(0, 8);
  const self: MeshSelf | null =
    ctx.selfPeerId === null
      ? null
      : {
          peerId: ctx.selfPeerId,
          keyPrefix: selfPrefix,
          validator: selfPrefix !== null && sets !== null && sets.current.has(selfPrefix),
          joinsAt: selfPrefix !== null && sets !== null ? (sets.next.get(selfPrefix)?.effectiveAt ?? null) : null,
        };
  const base = { side, at, fallback, setKnown: sets !== null, self, peers: { ...EMPTY, setSize: sets?.size ?? null }, validators: [] as MeshPeer[], missing: [] as string[] };
  if (status === 401 || status === 403) return { ...base, state: "closed", error: "peers endpoint closed by the operator" };
  if (status === 404) return { ...base, state: "absent", error: "node has no peers endpoint" };
  const m = obj(body);
  if (status !== 200 || m === null || !Array.isArray(m["peers"])) return { ...base, state: "unreachable", error: status === 0 ? "node did not answer" : "node answered with an error" };
  const seen = new Set<string>();
  const validators: MeshPeer[] = [];
  let total = 0;
  for (const raw of m["peers"].slice(0, MESH_MAX_SCAN)) {
    const p = obj(raw);
    const peerId = typeof p?.["peer_id"] === "string" && PEER_ID_RE.test(p["peer_id"]) ? p["peer_id"] : null;
    if (peerId === null || seen.has(peerId)) continue;
    seen.add(peerId);
    total++;
    if (sets === null) continue;
    const key = keyFromPeerId(peerId);
    if (key === null) continue;
    const prefix = key.slice(0, 8);
    const validator = sets.current.has(prefix);
    const joinsAt = sets.next.get(prefix)?.effectiveAt ?? null;
    if ((validator || joinsAt !== null) && validators.length < MESH_MAX_PEERS) validators.push({ peerId, keyPrefix: prefix, validator, joinsAt, connected: true });
  }
  validators.sort((a, b) => Number(b.validator) - Number(a.validator) || a.keyPrefix.localeCompare(b.keyPrefix));
  const present = new Set(validators.filter((v) => v.validator).map((v) => v.keyPrefix));
  const missing = sets === null ? [] : [...sets.current].filter((k) => !present.has(k) && k !== selfPrefix).sort();
  return { ...base, state: "open", error: null, peers: { total, validators: present.size, setSize: sets?.size ?? null }, validators, missing };
}

/** One line for a card or a bot: "validator, 5 of 8 validators connected" / "read node, 6 of 8 validators connected"; missing validators stay in the API and the change log. */
export function meshLine(m: MeshSummary | null): string {
  if (m === null) return "peers: no data";
  if (m.state !== "open") return `peers: ${m.state}`;
  const role = m.self === null ? "role unknown" : m.self.validator ? "validator" : "read node";
  if (!m.setKnown) return `${role}, ${m.peers.total} peers, validator set not loaded`;
  const n = m.peers.setSize ?? 0;
  const own = m.self?.validator ? 1 : 0;
  return `${role}, ${m.peers.validators} of ${Math.max(n - own, 0)} validators connected`;
}

export interface MeshDeps {
  /** The resolved validator sets for a side's network at its current heights; null when no file is configured or fetched yet. */
  resolve: (side: Side) => ResolvedSets | null;
}

export class MeshMonitor {
  private latest = new Map<Side, MeshSummary>();

  constructor(
    private readonly hubs: Record<Side, HubClient>,
    private readonly deps: MeshDeps,
    private readonly log: (m: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  async runAll(): Promise<void> {
    await Promise.all(
      Object.entries(this.hubs).map(async ([side, hub]) => {
        const r = await hub.peers();
        const next = summarizePeers(side, r.status, r.body, this.now(), r.fallback, { selfPeerId: hub.peerId, sets: this.deps.resolve(side) });
        const prev = this.latest.get(side);
        const sig = (s: MeshSummary) => `${meshLine(s)}|${s.missing.join(",")}`;
        if (prev === undefined || sig(prev) !== sig(next)) this.log(`[peers] ${side}: ${meshLine(next).replace(/^peers: /, "")}${next.missing.length > 0 ? ` (missing ${next.missing.join(", ")})` : ""}`);
        this.latest.set(side, next);
      }),
    );
  }

  snapshot(): Record<Side, MeshSummary> {
    return Object.fromEntries([...this.latest.entries()].map(([k, v]) => [k, { ...v, self: v.self === null ? null : { ...v.self }, peers: { ...v.peers }, validators: v.validators.map((p) => ({ ...p })), missing: [...v.missing] }]));
  }
}
