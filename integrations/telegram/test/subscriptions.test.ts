import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubStore, diffEvents, allow, MAX_LABELS_PER_CHAT, MAX_CHATS, QUIET_MS, type NodeState } from '../src/subscriptions.ts';
import { Snapdiff } from '../src/snapdiff.ts';
import { match } from '../src/trigger.ts';

const base = { privateChat: false, mentioned: false, replyToBot: false, invitedThread: false };
const state = (p: Partial<NodeState> = {}): NodeState => ({ network: 'hypersnap', reachable: true, error: null, stalledShards: [], ...p });

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
  assert.deepEqual(diffEvents('n', state({ reachable: null }), state({ reachable: false })), [], 'unknown to down is not a transition');
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
  assert.deepEqual(states.get('hyper-a'), { network: 'hypersnap', reachable: true, error: null, stalledShards: [1] });
  assert.equal(states.get('hyper-b')?.reachable, false);
  assert.deepEqual(states.get('hyper-b')?.stalledShards, []);
  assert.equal(states.has('ghost'), false, 'labels the API does not list are skipped, not invented');
  assert.deepEqual(calls.sort(), ['stalls', 'summary']);
  assert.deepEqual(await api.nodeList(), ['snap-a', 'hyper-a', 'hyper-b']);
  const broken = new Snapdiff((async () => { throw Error('offline'); }) as typeof fetch);
  assert.equal(await broken.nodeStates(['hyper-a']), null, 'no baseline change and no events when the API is down');
  assert.equal(await broken.nodeList(), null);
});
