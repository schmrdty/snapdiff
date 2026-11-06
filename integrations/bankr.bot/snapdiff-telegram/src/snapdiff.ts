import pkg from '../package.json' with { type: 'json' };
export const DASHBOARD = 'https://snapdiff.schmidtiest.xyz';
const API = `${DASHBOARD}/api`;
type Row = { fid: number; hash: string; presentNodes: string[]; presentOn: string; missingOn: string; scope: string | null; cause: string; resolvedAt?: number | null };
type Summary = { nodes: string[]; networks: Record<string, string[]>; reference: string; summary: { byCause: Record<string, number>; byScope: Record<string, number>; openStalls: number }; info: Record<string, { reachable: boolean; maxBlockDelay: number | null } | null> };
type Client = { label?: string; name?: string; network: string; status: string; latencyMs?: number | null; latency?: number | null; checkedAt: number | null };
type Stall = { endedAt: number | null };
const safe = (s: unknown) => String(s ?? '').replace(/https?:\/\/\S+|[\x00-\x1f\x7f-\x9f]/gi, '').slice(0, 80);
const age = (t: number | null, now: number) => t == null ? 'never' : `${Math.max(0, Math.floor((now - t) / 1000))}s ago`;
export class Snapdiff {
  private cache = new Map<string, { until: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();
  private errors = new Map<string, number>();
  constructor(private fetcher: typeof fetch = fetch, private now = Date.now) {}
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
  async report(fid?: number, clientName?: string): Promise<string> {
    try {
      const s = await this.get<Summary>('/summary');
      if (!Array.isArray(s.nodes) || !s.networks || !s.summary || !s.info) throw Error('invalid summary');
      const paths: Promise<unknown>[] = [];
      if (fid !== undefined) paths.push(this.get<Row[]>('/diffs?limit=5000'));
      if (clientName) paths.push(this.get<{ clients: Client[] }>('/clients'));
      if (s.summary.openStalls > 0) paths.push(this.get<Stall[]>('/stalls'));
      const results = await Promise.all(paths);
      let i = 0;
      const diffs = fid === undefined ? [] : results[i++] as Row[];
      const clients = !clientName ? null : results[i++] as { clients: Client[] };
      const stalls = s.summary.openStalls > 0 ? results[i++] as Stall[] : [];
      if ((fid !== undefined && !Array.isArray(diffs)) || (clients && !Array.isArray(clients.clients)) || !Array.isArray(stalls)) throw Error('invalid api response');
      const networks = Object.entries(s.networks).map(([network, labels]) => {
        if (!Array.isArray(labels)) throw Error('invalid network');
        const members = labels.filter(label => s.nodes.includes(label));
        const up = members.filter(label => s.info[label]?.reachable);
        const delays = up.map(label => s.info[label]?.maxBlockDelay).filter((v): v is number => typeof v === 'number');
        return `${safe(network)} ${up.length}/${members.length} up, worst delay ${delays.length ? `${Math.max(...delays)}s` : 'unknown'}`;
      });
      const scope = s.summary.byScope;
      const lines = [networks.join('; ') || 'no networks reported', `unexplained: node ${scope.node ?? 'unknown'}, network ${scope.network ?? 'unknown'}; pending ${s.summary.byCause.pending ?? 'unknown'}; stalls ${s.summary.openStalls > 0 ? stalls.filter(x => x.endedAt == null).length : 0}`];
      if (fid !== undefined) {
        const rows = diffs.filter(d => d.fid === fid && d.resolvedAt == null);
        const max = 2;
        if (!rows.length) lines.push(`FID ${fid}: no open diffs in latest ${diffs.length} rows`);
        for (const d of rows.slice(0, max)) {
          const present = d.presentNodes?.length ? d.presentNodes : [d.presentOn];
          lines.push(`FID ${fid}: cast ${safe(d.hash).slice(0, 10)} on ${present.map(safe).join(', ')}, missing on ${safe(d.missingOn)}, scope ${d.scope === null ? 'unknown' : safe(d.scope)}, ${safe(d.cause)}`);
        }
        if (rows.length > max && !clientName) lines.push(`FID ${fid}: ${rows.length - max} more open diffs in fetched rows`);
      }
      if (clientName) {
        const found = clients!.clients.find(c => (c.label ?? c.name)?.toLowerCase() === clientName.toLowerCase());
        lines.push(found ? `${safe(found.label ?? found.name)}: ${safe(found.status)}, latency ${typeof (found.latencyMs ?? found.latency) === 'number' ? `${found.latencyMs ?? found.latency}ms` : 'unknown'}, checked ${age(found.checkedAt, this.now())}` : `${safe(clientName)}: not listed in client health`);
      }
      return [...lines.slice(0, 5), DASHBOARD].join('\n');
    } catch { return `snapdiff api unavailable\n${DASHBOARD}`; }
  }
}
