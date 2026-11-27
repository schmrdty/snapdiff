// The bot says what the dashboard says (operator, 2026-11-25): its states (up, degraded, down)
// from /api/summary meta, its names (NODE_<K>_NAME), its order (Snapchain last; reference,
// validators, read nodes), its delay format, and every node in /status (it stopped at 12).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Snapdiff, MAX_STATUS_NODES, fmtDelay } from '../src/snapdiff.ts';
import { diffEvents, type NodeState } from '../src/subscriptions.ts';

const readers = Array.from({ length: 12 }, (_, i) => `reader${i + 1}`);
const hyper = ['hypersnap', 'hypersnape.node', ...readers, 'astrix', 'gone'];
const summary = {
  nodes: ['snapchain', ...hyper, 'crackle'],
  networks: { snapchain: ['snapchain', 'crackle'], hypersnap: hyper },
  reference: 'snapchain',
  meta: {
    snapchain: { name: 'snapchain', validator: false, reference: true, state: 'up' },
    crackle: { name: 'crackle', validator: true, reference: false, state: 'up' },
    hypersnap: { name: 'haatz', validator: true, reference: true, state: 'up' },
    'hypersnape.node': { name: 'snape', validator: true, reference: false, state: 'up' },
    ...Object.fromEntries(readers.map(r => [r, { name: r, validator: false, reference: false, state: 'up' }])),
    astrix: { name: 'astrix', validator: false, reference: false, state: 'degraded' },
    gone: { name: 'gone', validator: false, reference: false, state: 'down' },
  },
  summary: { byCause: {}, byScope: {}, openStalls: 0 },
  info: {
    snapchain: { reachable: true, maxBlockDelay: 1, provider: 'snap.example' },
    crackle: { reachable: true, maxBlockDelay: 1 },
    hypersnap: { reachable: true, maxBlockDelay: 2, provider: 'haatz.example' },
    'hypersnape.node': { reachable: true, maxBlockDelay: 1, provider: 'hypersnape.node' },
    ...Object.fromEntries(readers.map(r => [r, { reachable: true, maxBlockDelay: 1 }])),
    astrix: { reachable: true, maxBlockDelay: 59588, provider: 'procat.example:3381', version: '0.17.20' },
    gone: { reachable: false, maxBlockDelay: null, error: 'no answer within 10s' },
  },
};
const astrixNode = { label: 'astrix', name: 'astrix', network: 'hypersnap', state: 'degraded', latest: { at: 100000, reachable: true, maxBlockDelay: 59588, provider: 'procat.example:3381', shards: [{ shardId: 0, maxHeight: 51225085, blockDelay: 48169 }] }, window: { hours: 24, samples: 1118, uptimePct: 0.3, degraded: 3, worstDelay: 59588, stalls: 0 }, stalls: [] };
const snapeNode = { ...astrixNode, label: 'hypersnape.node', name: 'snape', state: 'up', validator: true, latest: { ...astrixNode.latest, maxBlockDelay: 1, provider: 'hypersnape.node' }, window: { ...astrixNode.window, degraded: 0, uptimePct: 100 } };
const fetcher = (calls: string[] = []) => (async (url: string) => {
  const path = new URL(url).pathname.replace(/^\/api/, '');
  calls.push(path);
  if (path === '/summary') return { ok: true, json: async () => summary } as Response;
  if (path === '/clients') return { ok: true, json: async () => ({ clients: [] }) } as Response;
  if (path === '/node/astrix') return { ok: true, json: async () => astrixNode } as Response;
  if (path === '/node/hypersnape.node') return { ok: true, json: async () => snapeNode } as Response;
  return { ok: false, status: 404, json: async () => ({ error: 'unknown node' }) } as Response;
}) as unknown as typeof fetch;

test('delay format matches the dashboard', () => {
  assert.deepEqual([fmtDelay(59), fmtDelay(119), fmtDelay(120), fmtDelay(7199), fmtDelay(59588)], ['59s', '119s', '2m', '120m', '16.6h']);
});

test('/status: every node, dashboard names and order, degraded as on the page', async () => {
  const lines = (await new Snapdiff(fetcher(), () => 130000).status()).split('\n');
  assert.equal(lines[0], 'hypersnap 15/16 answering (1 degraded), worst delay 16.6h; snapchain 2/2 answering, worst delay 1s');
  assert.equal(lines[1], 'haatz (hypersnap): up, delay 2s via haatz.example', 'the reference first, by its dashboard name');
  assert.equal(lines[2], 'snape (hypersnap): up, delay 1s via hypersnape.node', 'then validators');
  assert.ok(lines.includes('astrix (hypersnap): degraded, delay 16.6h via procat.example:3381'));
  assert.ok(lines.includes('gone (hypersnap): down, no answer within 10s'));
  assert.equal(lines.at(-3), 'crackle (snapchain): up, delay 1s', 'Snapchain below Hypersnap, reference before validators');
  assert.equal(lines.filter(l => / \((hypersnap|snapchain)\): /.test(l)).length, summary.nodes.length, 'no node is cut off');
  assert.ok(summary.nodes.length > 12 && summary.nodes.length <= MAX_STATUS_NODES);
});

test('/status falls back to reachable or not when the API has no meta', async () => {
  const bare = { ...summary, meta: undefined };
  const api = new Snapdiff((async (url: string) => ({ ok: true, json: async () => (String(url).endsWith('/summary') ? bare : { clients: [] }) })) as unknown as typeof fetch);
  const text = await api.status();
  assert.match(text, /^astrix \(hypersnap\): up, delay 16\.6h via procat\.example:3381$/m);
  assert.match(text, /^hypersnap \(hypersnap\): up/m, 'labels without names');
});

test('"is X down" and /node take the dashboard name as well as the label', async () => {
  const calls: string[] = [];
  const api = new Snapdiff(fetcher(calls), () => 130000);
  assert.match(await api.summary('snape'), /^snape \(hypersnap node\): up, delay 1s via hypersnape\.node; \/node snape for its last 24 h$/m);
  assert.match(await api.summary('astrix'), /^astrix \(hypersnap node\): degraded, delay 16\.6h via procat\.example:3381, v0\.17\.20; \/node astrix for its last 24 h$/m);
  const byName = (await api.node('snape')).split('\n');
  assert.equal(byName[0], 'snape (hypersnap validator): up, delay 1s via hypersnape.node, checked 30s ago');
  assert.ok(calls.includes('/node/snape') && calls.includes('/node/hypersnape.node'), 'label first, then the name resolved through the summary');
  const deg = (await api.node('astrix')).split('\n');
  assert.equal(deg[0], 'astrix (hypersnap): degraded, delay 16.6h via procat.example:3381, checked 30s ago');
  assert.equal(deg[1], 'last 24h: 1118 checks, 0.3% up (3 of them degraded), worst delay 16.6h, stalls 0');
  assert.equal(deg[2], 'shards: 0 at 51,225,085 (13.4h)');
  assert.match(await api.node('nobody'), /^nobody: not a listed node, \/status lists them/);
  assert.equal(await api.resolve('SNAPE'), 'hypersnape.node');
  assert.equal(await api.resolve('hypersnape.node'), 'hypersnape.node');
  assert.equal(await api.resolve('nobody'), null);
  assert.equal((await api.names()).get('hypersnap'), 'haatz');
});

test('nodeStates carries the name, the degraded verdict, and the delay', async () => {
  const s = await new Snapdiff(fetcher()).nodeStates(['astrix', 'hypersnape.node', 'gone']);
  assert.deepEqual([s?.get('astrix')?.name, s?.get('astrix')?.degraded, s?.get('astrix')?.delay], ['astrix', true, 59588]);
  assert.deepEqual([s?.get('hypersnape.node')?.name, s?.get('hypersnape.node')?.degraded], ['snape', false]);
  assert.equal(s?.get('gone')?.delay, null);
});

const st = (p: Partial<NodeState> = {}): NodeState => ({ name: 'snape', degraded: false, delay: 1, network: 'hypersnap', reachable: true, error: null, stalledShards: [], networkStalledShards: [], version: null, latestVersion: null, published: null, ...p });
test('events: degraded and caught up while answering, back up says it is catching up, stalls keep their own events', () => {
  const kinds = (a: NodeState, b: NodeState) => diffEvents('hypersnape.node', a, b).map(e => `${e.kind}: ${e.text}`);
  assert.deepEqual(kinds(st(), st({ degraded: true, delay: 600 })), ['degraded: snape (hypersnap): degraded, answering but behind, delay 10m'], 'the dashboard name, not the label');
  assert.deepEqual(kinds(st({ degraded: true, delay: 600 }), st()), ['caught-up: snape (hypersnap): caught up, delay 1s']);
  assert.deepEqual(kinds(st({ reachable: false, degraded: false, delay: null }), st({ degraded: true, delay: 59588 })), ['up: snape (hypersnap): back up, still catching up, delay 16.6h']);
  assert.deepEqual(kinds(st({ reachable: false, degraded: false, delay: null }), st()), ['up: snape (hypersnap): back up']);
  assert.deepEqual(kinds(st(), st({ degraded: true, stalledShards: [1] })), ['stall: snape (hypersnap): shard 1 stalled'], 'a stall is not also a degraded event');
  assert.deepEqual(kinds(st({ degraded: true, stalledShards: [1] }), st()), ['stall-ended: snape (hypersnap): shard 1 stall ended'], 'nor its end a caught-up event');
  assert.deepEqual(kinds(st({ degraded: null }), st({ degraded: true })), [], 'unknown before (older API) never fires');
  assert.deepEqual(kinds(st({ degraded: true }), st({ degraded: true, delay: 900 })), [], 'still degraded is quiet');
});
