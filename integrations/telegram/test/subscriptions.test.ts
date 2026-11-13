import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubStore, diffEvents, allow, MAX_LABELS_PER_CHAT, MAX_CHATS, QUIET_MS, type NodeState } from '../src/subscriptions.ts';
import { Snapdiff } from '../src/snapdiff.ts';
import { match } from '../src/trigger.ts';

const base = { privateChat: false, mentioned: false, replyToBot: false, invitedThread: false };
const state = (p: Partial<NodeState> = {}): NodeState => ({ network: 'hypersnap', reachable: true, error: null, stalledShards: [], networkStalledShards: [], version: null, latestVersion: null, ...p });

test('store: per-chat and total caps, idempotent add, remove one or all, file holds ids and labels only, reload', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'subs-')), 'subscriptions.json');
  const s = new SubStore(file);
  assert.equal(s.add(1, 'a'), 'added');
  assert.equal(s.add(1, 'a'), 'already');
  assert.equal(s.add(1, 'b'), 'added');
  assert.equal(s.add(1, 'c'), 'added');
  assert.equal(s.add(1, 'd'), 'chat-full');
  assert.equal(MAX_LABELS_PER_CHAT, 3);
  for (let c = 2; c <= MAX_CHATS; c++) assert.equal(s.add(c, 'a'), 'added');
  assert.equal(s.add(MAX_CHATS + 1, 'a'), 'bot-full', 'a new chat beyond the cap is refused');
  assert.equal(s.add(2, 'b'), 'added', 'an existing chat may still add within its own cap');
  assert.deepEqual(s.list(1), ['a', 'b', 'c']);
  assert.deepEqual(s.labels().sort(), ['a', 'b', 'c']);
  assert.equal(s.chatsFor('c').length, 1);
  assert.equal(s.chatsFor('a').length, MAX_CHATS);
  assert.equal(s.remove(1, 'b'), 1);
  assert.equal(s.remove(1, 'zzz'), 0);
  assert.equal(s.remove(1), 2, 'no label removes everything for that chat');
  assert.deepEqual(s.list(1), []);
  assert.equal(s.remove(1), 0);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes('"1"'), 'an emptied chat is dropped from the file');
  assert.match(raw, /^\{("-?\d+":\["[\w.-]+"(,"[\w.-]+")*\],?)+\}$/, 'file is chat ids to label lists, nothing else');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const again = new SubStore(file);
  assert.deepEqual(again.list(2), ['a', 'b'], 'subscriptions survive a restart');
  assert.equal(new SubStore(join(tmpdir(), 'does-not-exist', 'x.json')).chats(), 0, 'a missing file is an empty store');
});

test('events: baseline is silent, then down, back up, stall, stall ended; unchanged state yields nothing', () => {
  assert.deepEqual(diffEvents('n', undefined, state()), [], 'first sight is a baseline');
  assert.deepEqual(diffEvents('n', state(), state()), []);
  assert.deepEqual(diffEvents('n', state(), state({ reachable: false, error: 'timeout' })).map(e => [e.kind, e.text]), [['down', 'n (hypersnap): down, timeout']]);
  assert.deepEqual(diffEvents('n', state({ reachable: false }), state()).map(e => e.text), ['n (hypersnap): back up']);
  assert.deepEqual(diffEvents('n', state(), state({ stalledShards: [0, 2] })).map(e => e.text), ['n (hypersnap): shard 0 stalled', 'n (hypersnap): shard 2 stalled']);
  assert.deepEqual(diffEvents('n', state({ stalledShards: [0, 2] }), state({ stalledShards: [2] })).map(e => e.kind), ['stall-ended']);
  // A stall on every node of the network is the network's pause, worded without the label.
  const paused = state({ stalledShards: [0, 1], networkStalledShards: [0, 1] });
  assert.deepEqual(diffEvents('n', state(), paused).map(e => [e.kind, e.text]), [['stall', 'hypersnap: shard 0 stopped on every node (network-wide pause)'], ['stall', 'hypersnap: shard 1 stopped on every node (network-wide pause)']]);
  assert.deepEqual(diffEvents('n', paused, state()).map(e => e.text), ['hypersnap: shard 0 moving again on every node', 'hypersnap: shard 1 moving again on every node']);
  assert.deepEqual(diffEvents('n', paused, state({ stalledShards: [1] })).map(e => [e.kind, e.text]), [['stall-ended', 'hypersnap: shard 0 moving again on every node'], ['left-behind', 'n (hypersnap): still stalled on shard 1 while the rest of hypersnap moves again']]);
  assert.deepEqual(diffEvents('n', state({ stalledShards: [1] }), state({ stalledShards: [1], networkStalledShards: [1] })), [], 'a node stall widening to the network is not a new event for this node');
  assert.deepEqual(diffEvents('n', state({ reachable: null }), state({ reachable: false })), [], 'unknown to down is not a transition');
  // Version drift: behind when the network's newest moves past this node, current again after its upgrade; unknown versions are silent.
  const same = state({ version: '0.17.4', latestVersion: '0.17.4' });
  const lag = state({ version: '0.17.4', latestVersion: '0.17.5' });
  assert.deepEqual(diffEvents('n', same, lag).map(e => [e.kind, e.text]), [['behind', 'n (hypersnap): version 0.17.4 is behind, newest on hypersnap is 0.17.5']]);
  assert.deepEqual(diffEvents('n', lag, lag), [], 'staying behind does not repeat');
  assert.deepEqual(diffEvents('n', lag, state({ version: '0.17.5', latestVersion: '0.17.5' })).map(e => [e.kind, e.text]), [['current', 'n (hypersnap): version 0.17.5, current again']]);
  assert.deepEqual(diffEvents('n', state(), lag).map(e => e.kind), ['behind'], 'from unknown straight to behind fires once');
  assert.deepEqual(diffEvents('n', lag, state({ version: null, latestVersion: '0.17.5' })), [], 'losing the version (node down) is not "current"');
  assert.deepEqual(diffEvents('n', state({ version: '0.9.0', latestVersion: '0.10.0' }), state({ version: '0.9.0', latestVersion: '0.10.0' })), [], 'numeric compare, no re-fire');
  const quiet = new Map<string, number>();
  const e = diffEvents('n', state(), state({ reachable: false }))[0]!;
  assert.equal(allow(quiet, e, 0), true);
  assert.equal(allow(quiet, e, QUIET_MS - 1), false, 'same label and kind is silenced for the quiet window');
  assert.equal(allow(quiet, { ...e, kind: 'up' }, 1), true, 'another kind is not affected');
  assert.equal(allow(quiet, e, QUIET_MS), true);
});

test('trigger: /subscribe and /unsubscribe with and without a label', () => {
  assert.deepEqual(match({ ...base, text: '/subscribe' }), { command: 'subscribe' });
  assert.deepEqual(match({ ...base, text: '/subscribe castrater' }), { command: 'subscribe', node: 'castrater' });
  assert.deepEqual(match({ ...base, text: '/subscribe a b' }), { command: 'subscribe', help: true });
  assert.deepEqual(match({ ...base, text: '/subscribe help' }), { command: 'subscribe', help: true });
  assert.deepEqual(match({ ...base, text: '/unsubscribe' }), { command: 'unsubscribe' });
  assert.deepEqual(match({ ...base, text: '/unsubscribe hypersnape.node' }), { command: 'unsubscribe', node: 'hypersnape.node' });
  assert.deepEqual(match({ ...base, text: '/unsubscribe ???' }), { command: 'unsubscribe', help: true });
});

test('nodeStates: one summary call (plus stalls when open) gives reachability and open stalled shards per label; null when the API fails', async () => {
  const sample = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url), 'utf8'));
  const calls: string[] = [];
  const api = new Snapdiff((async (url: string) => { const key = new URL(url).pathname.split('/').at(-1)!; calls.push(key); return { ok: true, json: async () => sample[key] } as Response; }) as typeof fetch, () => 130000);
  const states = await api.nodeStates(['hyper-a', 'hyper-b', 'ghost']);
  assert.ok(states);
  assert.deepEqual(states.get('hyper-a'), { network: 'hypersnap', reachable: true, error: null, stalledShards: [1], networkStalledShards: [1], version: null, latestVersion: null }, 'a summary without versions gives null, never a guess; the open stall is scope network in the sample');
  const versioned = { ...sample, summary: { ...sample.summary, versions: { hypersnap: '0.17.5' }, info: { ...sample.summary.info, 'hyper-a': { ...sample.summary.info['hyper-a'], version: '0.17.4' } } } };
  const vapi = new Snapdiff((async (url: string) => ({ ok: true, json: async () => versioned[new URL(url).pathname.split('/').at(-1)!] }) as Response) as typeof fetch, () => 130000);
  const vs = await vapi.nodeStates(['hyper-a', 'hyper-b']);
  assert.equal(vs?.get('hyper-a')?.version, '0.17.4');
  assert.equal(vs?.get('hyper-a')?.latestVersion, '0.17.5', 'the network newest comes from summary.versions');
  assert.equal(vs?.get('hyper-b')?.version, null, 'a node without a version stays null');
  assert.equal(states.get('hyper-b')?.reachable, false);
  assert.deepEqual(states.get('hyper-b')?.stalledShards, []);
  assert.equal(states.has('ghost'), false, 'labels the API does not list are skipped, not invented');
  assert.deepEqual(calls.sort(), ['stalls', 'summary']);
  assert.deepEqual(await api.nodeList(), ['snap-a', 'hyper-a', 'hyper-b']);
  const broken = new Snapdiff((async () => { throw Error('offline'); }) as typeof fetch);
  assert.equal(await broken.nodeStates(['hyper-a']), null, 'no baseline change and no events when the API is down');
  assert.equal(await broken.nodeList(), null);
});
