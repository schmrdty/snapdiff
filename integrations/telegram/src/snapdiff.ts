import pkg from '../package.json' with { type: 'json' };
import type { NodeState } from './subscriptions.ts';
export const DASHBOARD = 'https://snapdiff.schmidtiest.xyz';
const API = `${DASHBOARD}/api`;
type Row = { fid: number; hash: string; presentNodes: string[]; presentOn: string; missingOn: string; scope: string | null; cause: string; resolvedAt?: number | null };
type Info = { reachable: boolean; maxBlockDelay: number | null; error?: string | null; provider?: string | null; version?: string | null } | null;
type Summary = { nodes: string[]; networks: Record<string, string[]>; reference: string; summary: { byCause: Record<string, number>; byScope: Record<string, number>; openStalls: number }; info: Record<string, Info>; versions?: Record<string, string | null> };
type Client = { label?: string; name?: string; network: string; status: string; latencyMs?: number | null; latency?: number | null; checkedAt: number | null };
type Stall = { side?: string; shardId?: number; scope?: string | null; endedAt: number | null };
type Shard = { shardId: number; maxHeight: number; blockDelay: number };
type Latest = { at: number; reachable: boolean; maxBlockDelay: number | null; error?: string | null; provider?: string | null; shards?: Shard[] } | null;
type NodeVersion = { current: string | null; latest: string | null; behind: boolean };
type NodeView = { label: string; name?: string; network: string; reference?: boolean; validator?: boolean; version?: NodeVersion; latest: Latest; window: { hours: number; samples: number; uptimePct: number | null; worstDelay: number | null; stalls: number }; stalls: { shardId: number; startedAt: number; endedAt: number | null }[] };
const safe = (s: unknown) => String(s ?? '').replace(/https?:\/\/\S+|[\x00-\x1f\x7f-\x9f]/gi, '').slice(0, 80);
const age = (t: number | null, now: number) => t == null ? 'never' : `${Math.max(0, Math.floor((now - t) / 1000))}s ago`;
// ", v0.17.4 (behind, newest 0.17.5)" or ", v0.17.5"; nothing when the API has no version for the node.
const versionText = (v: NodeVersion | undefined) => v && typeof v.current === 'string' ? `, v${safe(v.current)}${v.behind && v.latest ? ` (behind, newest ${safe(v.latest)})` : ''}` : '';
const UNAVAILABLE = `snapdiff api unavailable\n${DASHBOARD}`;
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
    const parts = Object.entries(s.networks).map(([network, labels]) => {
      if (!Array.isArray(labels)) throw Error('invalid network');
      const members = labels.filter(label => s.nodes.includes(label));
      const up = members.filter(label => s.info[label]?.reachable);
      const delays = up.map(label => s.info[label]?.maxBlockDelay).filter((v): v is number => typeof v === 'number');
      return `${safe(network)} ${up.length}/${members.length} up, worst delay ${delays.length ? `${Math.max(...delays)}s` : 'unknown'}`;
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
    const label = s.nodes.find(n => typeof n === 'string' && n.toLowerCase() === name.toLowerCase());
    if (!label) return null;
    const network = Object.entries(s.networks).find(([, members]) => Array.isArray(members) && members.includes(label))?.[0] ?? 'unknown';
    const i = s.info[label];
    const who = `${safe(label)} (${safe(network)} node)`;
    const more = `; /node ${safe(label)} for its last 24 h`;
    if (!i) return `${who}: no data yet${more}`;
    if (!i.reachable) return `${who}: down${i.error ? `, ${safe(i.error)}` : ''}${more}`;
    return `${who}: up, delay ${typeof i.maxBlockDelay === 'number' ? `${i.maxBlockDelay}s` : 'unknown'}${i.provider ? ` via ${safe(i.provider)}` : ''}${typeof i.version === 'string' ? `, v${safe(i.version)}` : ''}${more}`;
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
  /** /status: every node and every watched client, no diff counts. */
  async status(): Promise<string> {
    try {
      const { s, open } = await this.summaryAndStalls();
      const c = await this.get<{ clients: Client[] }>('/clients');
      if (!Array.isArray(c.clients)) throw Error('invalid clients');
      const networkOf = new Map<string, string>();
      for (const [network, labels] of Object.entries(s.networks)) if (Array.isArray(labels)) for (const l of labels) networkOf.set(l, network);
      const lines = [this.networkLine(s)];
      for (const label of s.nodes.slice(0, 12)) {
        const i = s.info[label];
        const who = `${safe(label)} (${safe(networkOf.get(label) ?? 'unknown')})`;
        if (!i) lines.push(`${who}: no data yet`);
        else if (!i.reachable) lines.push(`${who}: down${i.error ? `, ${safe(i.error)}` : ''}`);
        else lines.push(`${who}: up, delay ${typeof i.maxBlockDelay === 'number' ? `${i.maxBlockDelay}s` : 'unknown'}${i.provider ? ` via ${safe(i.provider)}` : ''}`);
      }
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
      catch (e) { if (e instanceof Error && e.message === 'snapdiff http 404') return `${safe(label)}: not a listed node, /status lists them\n${DASHBOARD}`; throw e; }
      if (typeof v.label !== 'string' || !v.window) throw Error('invalid node');
      const now = this.now();
      const who = `${safe(v.name ?? v.label)} (${safe(v.network)}${v.validator ? ' validator' : ''}${v.reference ? ', reference' : ''})`;
      const l = v.latest;
      const lines: string[] = [];
      if (!l) lines.push(`${who}: no data yet`);
      else if (!l.reachable) lines.push(`${who}: down${l.error ? `, ${safe(l.error)}` : ''}, checked ${age(l.at, now)}`);
      else lines.push(`${who}: up, delay ${typeof l.maxBlockDelay === 'number' ? `${l.maxBlockDelay}s` : 'unknown'}${l.provider ? ` via ${safe(l.provider)}` : ''}, checked ${age(l.at, now)}${versionText(v.version)}`);
      const w = v.window;
      lines.push(`last ${w.hours}h: ${w.samples} checks, ${w.uptimePct ?? 'unknown'}% up, worst delay ${typeof w.worstDelay === 'number' ? `${w.worstDelay}s` : 'unknown'}, stalls ${w.stalls}`);
      if (l?.reachable && Array.isArray(l.shards) && l.shards.length) lines.push(`shards: ${l.shards.slice(0, 8).map(s => `${s.shardId} at ${Number(s.maxHeight).toLocaleString('en-US')} (${s.blockDelay}s)`).join('; ')}`);
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
        out.set(label, { network: safe(network), reachable: i ? i.reachable === true : null, error: i && !i.reachable && i.error ? safe(i.error) : null, stalledShards, networkStalledShards, version: i && typeof i.version === 'string' ? safe(i.version) : null, latestVersion });
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
