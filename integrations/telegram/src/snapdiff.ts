import pkg from '../package.json' with { type: 'json' };
import type { NodeState } from './subscriptions.ts';
export const DASHBOARD = 'https://snapdiff.schmidtiest.xyz';
const API = `${DASHBOARD}/api`;
type Row = { fid: number; hash: string; presentNodes: string[]; presentOn: string; missingOn: string; scope: string | null; cause: string; resolvedAt?: number | null };
type Info = { reachable: boolean; maxBlockDelay: number | null; error?: string | null; provider?: string | null; version?: string | null } | null;
type Meta = { name?: string; validator?: boolean; reference?: boolean; state?: string };
type Summary = { nodes: string[]; networks: Record<string, string[]>; reference: string; meta?: Record<string, Meta>; summary: { byCause: Record<string, number>; byScope: Record<string, number>; openStalls: number }; info: Record<string, Info>; versions?: Record<string, string | null>; releases?: Record<string, { version?: string | null } | null> };
type Client = { label?: string; name?: string; network: string; status: string; latencyMs?: number | null; latency?: number | null; checkedAt: number | null };
type Stall = { side?: string; shardId?: number; scope?: string | null; endedAt: number | null };
type Shard = { shardId: number; maxHeight: number; blockDelay: number };
type Latest = { at: number; reachable: boolean; maxBlockDelay: number | null; error?: string | null; provider?: string | null; shards?: Shard[] } | null;
type NodeVersion = { current: string | null; latest: string | null; behind: boolean };
type NodeView = { label: string; name?: string; network: string; reference?: boolean; validator?: boolean; state?: string; version?: NodeVersion; latest: Latest; window: { hours: number; samples: number; uptimePct: number | null; degraded?: number; worstDelay: number | null; stalls: number }; stalls: { shardId: number; startedAt: number; endedAt: number | null }[] };
const safe = (s: unknown) => String(s ?? '').replace(/https?:\/\/\S+|[\x00-\x1f\x7f-\x9f]/gi, '').slice(0, 80);
const age = (t: number | null, now: number) => t == null ? 'never' : `${Math.max(0, Math.floor((now - t) / 1000))}s ago`;
// ", v0.17.4 (behind, newest 0.17.5)" or ", v0.17.5"; nothing when the API has no version for the node.
const versionText = (v: NodeVersion | undefined) => v && typeof v.current === 'string' ? `, v${safe(v.current)}${v.behind && v.latest ? ` (behind, newest ${safe(v.latest)})` : ''}` : '';
const UNAVAILABLE = `snapdiff api unavailable\n${DASHBOARD}`;
/**
 * The dashboard's words for a node, and its verdict (Ryan, 2026-11-25): snapdiff computes the
 * state (src/server.ts nodeState, sent as /api/summary meta and /api/node state) and the bot
 * repeats it instead of re-deriving it. "degraded" = answering but a shard is past the
 * dashboard's behind line or stalled. An older API without the field falls back to
 * reachable or not, the rule the bot had before.
 */
export type State = 'up' | 'degraded' | 'down' | 'no data';
const STATES: readonly string[] = ['up', 'degraded', 'down', 'no data'];
const pickState = (given: unknown, reachable: boolean | undefined): State =>
  typeof given === 'string' && STATES.includes(given) ? given as State : reachable === undefined ? 'no data' : reachable ? 'up' : 'down';
const stateOf = (s: Summary, label: string): State => pickState(s.meta?.[label]?.state, s.info[label] ? s.info[label]!.reachable === true : undefined);
/** NODE_<K>_NAME as the dashboard prints it, else the label. */
const nameOf = (s: Summary, label: string): string => safe(s.meta?.[label]?.name || label);
/** The dashboard's delay format (src/server.ts fmtDelay): seconds, then minutes, then hours. */
export const fmtDelay = (sec: number): string => (sec < 120 ? `${sec}s` : sec < 7200 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`);
const delayText = (d: unknown): string => (typeof d === 'number' ? fmtDelay(d) : 'unknown');
/**
 * The dashboard's order: Snapchain networks below the rest, and inside a network the reference
 * first, then validators, then read nodes, each in config order. Labels not in any network go last.
 */
function ordered(s: Summary): { network: string; labels: string[] }[] {
  const nets = Object.entries(s.networks).filter(([, ls]) => Array.isArray(ls))
    .sort(([a], [b]) => Number(a.includes('snapchain')) - Number(b.includes('snapchain')));
  const rank = (l: string) => (s.meta?.[l]?.reference ? 0 : s.meta?.[l]?.validator ? 1 : 2);
  const out = nets.map(([network, ls]) => ({ network, labels: ls.filter(l => s.nodes.includes(l)).map((l, i) => ({ l, i })).sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i).map(x => x.l) }));
  const placed = new Set(out.flatMap(n => n.labels));
  const rest = s.nodes.filter(l => !placed.has(l));
  return rest.length ? [...out, { network: 'unknown', labels: rest }] : out;
}
/** Label for a label or a dashboard name, any case; null when neither. */
const findLabel = (s: Summary, x: string): string | null => {
  const lower = x.toLowerCase();
  return s.nodes.find(n => typeof n === 'string' && n.toLowerCase() === lower)
    ?? s.nodes.find(n => typeof n === 'string' && (s.meta?.[n]?.name ?? '').toLowerCase() === lower) ?? null;
};
/** "up, delay 2s via host", "degraded, delay 16.6h via host", "down, <error>", "no data yet". */
const stateText = (state: State, i: Info | Latest | undefined): string => {
  if (state === 'no data' || !i) return 'no data yet';
  if (state === 'down') return `down${i.error ? `, ${safe(i.error)}` : ''}`;
  return `${state}, delay ${delayText(i.maxBlockDelay)}${i.provider ? ` via ${safe(i.provider)}` : ''}`;
};
/** /status lists every node; this bounds one Telegram message (4096 characters) if the list grows. */
export const MAX_STATUS_NODES = 40;
export class Snapdiff {
  private cache = new Map<string, { until: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();
  private errors = new Map<string, number>();
  // Plain fields, not parameter properties: Node 24 runs .ts files in strip-only mode,
  // which rejects parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
  }
  private async get<T>(path: string): Promise<T> {
    const cached = this.cache.get(path);
    if (cached && this.now() < cached.until) return cached.value as T;
    if (this.now() < (this.errors.get(path) ?? 0)) throw Error('upstream cooling down');
    const pending = this.inflight.get(path);
    if (pending) return pending as Promise<T>;
    const task = (async () => {
      const r = await this.fetcher(`${API}${path}`, { headers: { 'User-Agent': `snapdiff-telegram/${pkg.version}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`snapdiff http ${r.status}`);
      const value = await r.json() as T;
      this.cache.set(path, { value, until: this.now() + 30000 });
      return value;
    })();
    this.inflight.set(path, task);
    try { return await task; } catch (e) { this.errors.set(path, this.now() + 30000); throw e; } finally { this.inflight.delete(path); }
  }
  private async summaryAndStalls(): Promise<{ s: Summary; open: number }> {
    const s = await this.get<Summary>('/summary');
    if (!Array.isArray(s.nodes) || !s.networks || !s.summary || !s.info) throw Error('invalid summary');
    let open = 0;
    if (s.summary.openStalls > 0) {
      const stalls = await this.get<Stall[]>('/stalls');
      if (!Array.isArray(stalls)) throw Error('invalid stalls');
      open = stalls.filter(x => x.endedAt == null).length;
    }
    return { s, open };
  }
  private networkLine(s: Summary): string {
    if (Object.values(s.networks).some(ls => !Array.isArray(ls))) throw Error('invalid network');
    // Degraded counts as answering, as on the dashboard's network badge.
    const parts = ordered(s).filter(n => n.network !== 'unknown').map(({ network, labels: members }) => {
      const states = members.map(l => stateOf(s, l));
      const answering = states.filter(x => x === 'up' || x === 'degraded').length;
      const degraded = states.filter(x => x === 'degraded').length;
      const delays = members.filter(l => s.info[l]?.reachable).map(l => s.info[l]?.maxBlockDelay).filter((v): v is number => typeof v === 'number');
      return `${safe(network)} ${answering}/${members.length} answering${degraded ? ` (${degraded} degraded)` : ''}, worst delay ${delays.length ? fmtDelay(Math.max(...delays)) : 'unknown'}`;
    });
    return parts.join('; ') || 'no networks reported';
  }
  private async clientLine(name: string): Promise<string> {
    const c = await this.get<{ clients: Client[] }>('/clients');
    if (!Array.isArray(c.clients)) throw Error('invalid clients');
    const found = c.clients.find(x => (x.label ?? x.name)?.toLowerCase() === name.toLowerCase());
    if (!found) return `${safe(name)}: not listed in client health`;
    const ms = found.latencyMs ?? found.latency;
    return `${safe(found.label ?? found.name)}: ${safe(found.status)}, latency ${typeof ms === 'number' ? `${ms}ms` : 'unknown'}, checked ${age(found.checkedAt, this.now())}`;
  }
  /**
   * "is X down" where X is a node label (case-insensitive): answered from the summary already in
   * hand, so no client fetch. People ask about nodes far more often than about clients, and the
   * old answer ("not listed in client health") read as a failure. Null when X is not a node.
   */
  private nodeLine(s: Summary, name: string): string | null {
    const label = findLabel(s, name);
    if (!label) return null;
    const network = Object.entries(s.networks).find(([, members]) => Array.isArray(members) && members.includes(label))?.[0] ?? 'unknown';
    const i = s.info[label];
    const state = stateOf(s, label);
    const who = `${nameOf(s, label)} (${safe(network)} node)`;
    const more = `; /node ${nameOf(s, label)} for its last 24 h`;
    const ver = state !== 'down' && state !== 'no data' && typeof i?.version === 'string' ? `, v${safe(i.version)}` : '';
    return `${who}: ${stateText(state, i)}${ver}${more}`;
  }
  /** /snapdiff and mentions: the network picture and open diff counts, plus one node or client when asked "is X down". */
  async summary(clientName?: string): Promise<string> {
    try {
      const { s, open } = await this.summaryAndStalls();
      const scope = s.summary.byScope;
      const lines = [this.networkLine(s), `unexplained: node ${scope.node ?? 'unknown'}, network ${scope.network ?? 'unknown'}; pending ${s.summary.byCause.pending ?? 'unknown'}; stalls ${open}`];
      if (clientName) lines.push(this.nodeLine(s, clientName) ?? await this.clientLine(clientName));
      return [...lines, DASHBOARD].join('\n');
    } catch { return UNAVAILABLE; }
  }
  /** /consensus: snapdiff's per-shard lines (src/consensus.ts there), one block per network. */
  async consensus(): Promise<string> {
    try {
      const c = await this.get<{ lines: Record<string, string[]> }>('/consensus');
      if (!c.lines || typeof c.lines !== 'object') throw Error('invalid consensus');
      const blocks = Object.entries(c.lines).filter(([, v]) => Array.isArray(v) && v.length > 0).slice(0, 4)
        .map(([network, lines]) => [`${safe(network)}:`, ...lines.slice(0, 6).map(l => `  ${safe(l)}`)].join('\n'));
      if (blocks.length === 0) return `no network has a validators file configured\n${DASHBOARD}`;
      return [...blocks, 'can vote = at the tip now; quorum = signatures a block needs', DASHBOARD].join('\n');
    } catch { return UNAVAILABLE; }
  }
  /** /status: every node and every watched client, no diff counts. */
  async status(): Promise<string> {
    try {
      const { s, open } = await this.summaryAndStalls();
      const c = await this.get<{ clients: Client[] }>('/clients');
      if (!Array.isArray(c.clients)) throw Error('invalid clients');
      const lines = [this.networkLine(s)];
      // Every node, in the dashboard's order. It used to stop at the first 12 in config order,
      // which left out 10 of 22 nodes on 2026-11-25 (astrix, castrater, most of Snapchain, testnet).
      const all = ordered(s).flatMap(n => n.labels.map(label => ({ label, network: n.network })));
      for (const { label, network } of all.slice(0, MAX_STATUS_NODES)) lines.push(`${nameOf(s, label)} (${safe(network)}): ${stateText(stateOf(s, label), s.info[label] ?? undefined)}`);
      if (all.length > MAX_STATUS_NODES) lines.push(`${all.length - MAX_STATUS_NODES} more nodes on the dashboard`);
      lines.push(c.clients.length ? `clients: ${c.clients.slice(0, 10).map(x => `${safe(x.label ?? x.name)} ${safe(x.status)}`).join(', ')}` : 'clients: none watched');
      if (open > 0) lines.push(`stalls: ${open} open`);
      return [...lines, DASHBOARD].join('\n');
    } catch { return UNAVAILABLE; }
  }
  /** /node: one node by label, its last 24 h, and its newest stall. Unknown labels get a pointer to /status. */
  async node(label: string): Promise<string> {
    try {
      let v: NodeView;
      try { v = await this.get<NodeView>(`/node/${encodeURIComponent(label)}`); }
      catch (e) {
        if (!(e instanceof Error && e.message === 'snapdiff http 404')) throw e;
        // Not a label: it may be the name the dashboard and /status print (NODE_<K>_NAME).
        let real: string | null = null;
        try { const s = await this.get<Summary>('/summary'); real = Array.isArray(s.nodes) ? findLabel(s, label) : null; } catch { real = null; }
        if (real === null || real === label) return `${safe(label)}: not a listed node, /status lists them\n${DASHBOARD}`;
        v = await this.get<NodeView>(`/node/${encodeURIComponent(real)}`);
      }
      if (typeof v.label !== 'string' || !v.window) throw Error('invalid node');
      const now = this.now();
      const who = `${safe(v.name ?? v.label)} (${safe(v.network)}${v.validator ? ' validator' : ''}${v.reference ? ', reference' : ''})`;
      const l = v.latest;
      const lines: string[] = [];
      const state = l ? pickState(v.state, l.reachable === true) : 'no data';
      if (!l) lines.push(`${who}: no data yet`);
      else lines.push(`${who}: ${stateText(state, l)}, checked ${age(l.at, now)}${state === 'down' ? '' : versionText(v.version)}`);
      const w = v.window;
      lines.push(`last ${w.hours}h: ${w.samples} checks, ${w.uptimePct ?? 'unknown'}% up${typeof w.degraded === 'number' && w.degraded > 0 ? ` (${w.degraded} of them degraded)` : ''}, worst delay ${delayText(w.worstDelay)}, stalls ${w.stalls}`);
      if (l?.reachable && Array.isArray(l.shards) && l.shards.length) lines.push(`shards: ${l.shards.slice(0, 8).map(s => `${s.shardId} at ${Number(s.maxHeight).toLocaleString('en-US')} (${fmtDelay(Number(s.blockDelay))})`).join('; ')}`);
      const st = Array.isArray(v.stalls) ? v.stalls[0] : undefined;
      if (st) lines.push(`last stall: shard ${st.shardId}, started ${age(st.startedAt, now)}, ${st.endedAt == null ? 'still open' : `lasted ${Math.max(1, Math.round((st.endedAt - st.startedAt) / 60000))} min`}`);
      return [...lines, DASHBOARD].join('\n');
    } catch { return UNAVAILABLE; }
  }
  /** Labels snapdiff lists, in order, for validating /subscribe; null when the API is unavailable. */
  async nodeList(): Promise<string[] | null> {
    try {
      const s = await this.get<Summary>('/summary');
      return Array.isArray(s.nodes) ? s.nodes.filter((n): n is string => typeof n === 'string') : null;
    } catch { return null; }
  }
  /**
   * /subscribe and /unsubscribe: the label for a label or a dashboard name. null when it is
   * neither, undefined when the API is unavailable.
   */
  async resolve(x: string): Promise<string | null | undefined> {
    try {
      const s = await this.get<Summary>('/summary');
      return Array.isArray(s.nodes) ? findLabel(s, x) : undefined;
    } catch { return undefined; }
  }
  /** Dashboard name per label, for printing a chat's subscriptions; an empty map when unavailable. */
  async names(): Promise<Map<string, string>> {
    try {
      const s = await this.get<Summary>('/summary');
      return new Map(Array.isArray(s.nodes) ? s.nodes.map(l => [l, nameOf(s, l)] as const) : []);
    } catch { return new Map(); }
  }
  /** Poller input: reachability and open stalled shards for the followed labels. Null when the API is unavailable, so the caller keeps its baseline. */
  async nodeStates(labels: string[]): Promise<Map<string, NodeState> | null> {
    try {
      const s = await this.get<Summary>('/summary');
      if (!Array.isArray(s.nodes) || !s.networks || !s.summary || !s.info) throw Error('invalid summary');
      let open: Stall[] = [];
      if (s.summary.openStalls > 0) {
        const stalls = await this.get<Stall[]>('/stalls');
        if (!Array.isArray(stalls)) throw Error('invalid stalls');
        open = stalls.filter(x => x.endedAt == null);
      }
      const networkOf = new Map<string, string>();
      for (const [network, ls] of Object.entries(s.networks)) if (Array.isArray(ls)) for (const l of ls) networkOf.set(l, network);
      const out = new Map<string, NodeState>();
      for (const label of labels) {
        if (!s.nodes.includes(label)) continue;
        const i = s.info[label];
        const mine = open.filter(x => x.side === label && typeof x.shardId === 'number');
        const stalledShards = mine.map(x => x.shardId as number).sort((a, b) => a - b);
        const networkStalledShards = mine.filter(x => x.scope === 'network').map(x => x.shardId as number).sort((a, b) => a - b);
        const network = networkOf.get(label) ?? 'unknown';
        const latestVersion = s.versions && typeof s.versions[network] === 'string' ? safe(s.versions[network]) : null;
        const rel = s.releases ? s.releases[network] : null;
        const published = rel && typeof rel.version === 'string' ? safe(rel.version) : null;
        const st = stateOf(s, label);
        out.set(label, { name: nameOf(s, label), degraded: s.meta?.[label]?.state === undefined ? null : st === 'degraded', delay: i && i.reachable && typeof i.maxBlockDelay === 'number' ? i.maxBlockDelay : null, network: safe(network), reachable: i ? i.reachable === true : null, error: i && !i.reachable && i.error ? safe(i.error) : null, stalledShards, networkStalledShards, version: i && typeof i.version === 'string' ? safe(i.version) : null, latestVersion, published });
      }
      return out;
    } catch { return null; }
  }
  /** /fid: only that account's open diffs, or the lack of them. */
  async fid(fid: number): Promise<string> {
    try {
      const diffs = await this.get<Row[]>('/diffs?limit=5000');
      if (!Array.isArray(diffs)) throw Error('invalid diffs');
      const rows = diffs.filter(d => d.fid === fid && d.resolvedAt == null);
      const max = 3;
      const lines: string[] = [];
      if (!rows.length) lines.push(`FID ${fid}: no open diffs in the latest ${diffs.length} rows`);
      for (const d of rows.slice(0, max)) {
        const present = d.presentNodes?.length ? d.presentNodes : [d.presentOn];
        lines.push(`FID ${fid}: cast ${safe(d.hash).slice(0, 10)} on ${present.map(safe).join(', ')}, missing on ${safe(d.missingOn)}, scope ${d.scope === null ? 'unknown' : safe(d.scope)}, ${safe(d.cause)}`);
      }
      if (rows.length > max) lines.push(`FID ${fid}: ${rows.length - max} more open diffs in fetched rows`);
      return [...lines, DASHBOARD].join('\n');
    } catch { return UNAVAILABLE; }
  }
}
