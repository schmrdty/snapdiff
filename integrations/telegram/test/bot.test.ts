import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Snapdiff } from '../src/snapdiff.ts';
import { match } from '../src/trigger.ts';
import { recordFeedback, FEEDBACK_MAX } from '../src/feedback.ts';
import pkg from '../package.json' with { type: 'json' };
const sample = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url), 'utf8'));
const base = { privateChat: false, mentioned: false, replyToBot: false, invitedThread: false };
const sampleFetch = (calls: string[] = []) => (async (url: string, init?: RequestInit) => {
  assert.equal(new Headers(init?.headers).get('User-Agent'), `snapdiff-telegram/${pkg.version}`);
  assert.equal(new Headers(init?.headers).has('x-api-key'), false);
  const key = new URL(url).pathname.split('/').at(-1)!;
  calls.push(key);
  return { ok: true, json: async () => sample[key] } as Response;
}) as typeof fetch;

test('trigger gate, FID validation, and help on blank or "help" arguments', () => {
  assert.equal(match({ ...base, text: 'cast not showing' }), null, 'symptom phrase needs to be addressed');
  assert.equal(match({ ...base, replyToBot: true, text: "can't see my cast" })?.command, 'mention');
  assert.equal(match({ ...base, privateChat: true, text: 'hello there' }), null, 'unrelated DM text is ignored');
  assert.equal(match({ ...base, text: '/fid 123' })?.fid, 123);
  assert.deepEqual(match({ ...base, text: '/fid 999999999999999999999' }), { command: 'fid', help: true });
  assert.deepEqual(match({ ...base, text: '/fid' }), { command: 'fid', help: true });
  assert.deepEqual(match({ ...base, text: '/fid help' }), { command: 'fid', help: true });
  assert.deepEqual(match({ ...base, text: '/feedback' }), { command: 'feedback', help: true });
  assert.deepEqual(match({ ...base, text: '/tip help' }), { command: 'tip', help: true });
  assert.deepEqual(match({ ...base, text: '/tip' }), { command: 'tip' });
  assert.deepEqual(match({ ...base, text: '/help' }), { command: 'help', help: true });
  assert.deepEqual(match({ ...base, text: '/start' }), { command: 'help', help: true });
  assert.equal(match({ ...base, text: '/status@snapdiff_bot' })?.command, 'status');
  assert.deepEqual(match({ ...base, text: '/node hypersnape.node' }), { command: 'node', node: 'hypersnape.node' });
  assert.deepEqual(match({ ...base, text: '/node' }), { command: 'node', help: true });
  assert.deepEqual(match({ ...base, text: '/node a b' }), { command: 'node', help: true }, 'spaces are not a label');
  assert.deepEqual(match({ ...base, text: '/node https://x' }), { command: 'node', help: true });
  assert.equal(match({ ...base, mentioned: true, text: 'stop' })?.stop, true);
  assert.equal(match({ ...base, text: 'is Quilcast down' }), null);
  assert.equal(match({ ...base, replyToBot: true, text: 'is Quilcast down' })?.client, 'Quilcast');
  assert.equal(match({ ...base, text: '/snapdiff is Quilcast down' })?.client, 'Quilcast');
});

test('/snapdiff: network line, counts, optional client line, endpoint gating, cache', async () => {
  const calls: string[] = [];
  const api = new Snapdiff(sampleFetch(calls), () => 130000);
  const one = await api.summary('Quilcast');
  assert.match(one, /snapchain 1\/1 up, worst delay 2s; hypersnap 1\/2 up, worst delay 6s/);
  assert.match(one, /unexplained: node 1, network 1; pending 1; stalls 1/);
  assert.match(one, /Quilcast: degraded, latency 210ms, checked 30s ago/);
  assert.equal(one.split('\n').length, 4);
  assert.ok(!one.includes('evil.example'));
  await api.summary('Quilcast');
  assert.deepEqual(calls.sort(), ['clients', 'stalls', 'summary'], 'diffs never fetched for a summary; second call served from cache');
});

test('/status: one line per node with network, clients line, stalls line, no diff counts', async () => {
  const api = new Snapdiff(sampleFetch(), () => 130000);
  const text = await api.status();
  const lines = text.split('\n');
  assert.match(lines[0]!, /snapchain 1\/1 up/);
  assert.equal(lines[1], 'snap-a (snapchain): up, delay 2s');
  assert.equal(lines[2], 'hyper-a (hypersnap): up, delay 6s');
  assert.equal(lines[3], 'hyper-b (hypersnap): down');
  assert.equal(lines[4], 'clients: Quilcast degraded');
  assert.equal(lines[5], 'stalls: 1 open');
  assert.ok(!text.includes('unexplained'), 'status does not repeat the diff counts');
  const empty = new Snapdiff((async url => ({ ok: true, json: async () => String(url).endsWith('/clients') ? { clients: [] } : sample[new URL(String(url)).pathname.split('/').at(-1)!] }) as unknown as Response) as typeof fetch);
  assert.match(await empty.status(), /clients: none watched/);
});

test('/fid: only that FID, no network lines, overflow count', async () => {
  const api = new Snapdiff(sampleFetch());
  const hit = await api.fid(123);
  assert.ok(!hit.includes('up, worst delay'), 'no network summary in a FID reply');
  assert.match(hit, /FID 123: cast 0x.{8} on .*missing on .*scope network, unexplained/);
  const miss = await api.fid(424242);
  assert.match(miss, /FID 424242: no open diffs in the latest \d+ rows/);
  const rows = Array.from({ length: 10 }, (_, i) => ({ ...sample.diffs[0], hash: `0xabcdef${i}000000000` }));
  const many = new Snapdiff((async url => ({ ok: true, json: async () => String(url).endsWith('/diffs?limit=5000') ? rows : sample[new URL(String(url)).pathname.split('/').at(-1)!] }) as unknown as Response) as typeof fetch);
  const text = await many.fid(123);
  assert.equal(text.split('\n').length, 5, 'three rows, one overflow line, the dashboard');
  assert.ok(text.includes('7 more open diffs'));
});

test('/node: one node now, its window, shards, newest stall; unknown label points at /status', async () => {
  const calls: string[] = [];
  const api = new Snapdiff(sampleFetch(calls), () => 130000);
  const lines = (await api.node('hyper-a')).split('\n');
  assert.equal(lines[0], 'hyper-a (hypersnap): up, delay 3s via hyper-a, checked 35s ago');
  assert.equal(lines[1], 'last 24h: 1440 checks, 99.8% up, worst delay 9s, stalls 1');
  assert.equal(lines[2], 'shards: 0 at 50,000,000 (3s); 1 at 51,000,000 (1s)');
  assert.equal(lines[3], 'last stall: shard 1, started 40s ago, still open');
  assert.equal(lines[4], 'https://snapdiff.schmidtiest.xyz');
  assert.equal(lines.length, 5);
  assert.deepEqual(calls, ['hyper-a'], 'only the node endpoint, nothing else');
  const val = new Snapdiff((async () => ({ ok: true, json: async () => ({ ...sample['hyper-a'], validator: true, reference: true }) }) as Response) as unknown as typeof fetch, () => 130000);
  assert.equal((await val.node('hyper-a')).split('\n')[0], 'hyper-a (hypersnap validator, reference): up, delay 3s via hyper-a, checked 35s ago', 'validator is named after the network');
  const missing = new Snapdiff((async () => ({ ok: false, status: 404, json: async () => ({ error: 'unknown node' }) })) as unknown as typeof fetch);
  assert.equal(await missing.node('nope'), 'nope: not a listed node, /status lists them\nhttps://snapdiff.schmidtiest.xyz');
  const down = new Snapdiff((async () => ({ ok: true, json: async () => ({ ...sample['hyper-a'], latest: { at: 100000, reachable: false, maxBlockDelay: null, error: 'timeout' }, stalls: [] }) })) as unknown as typeof fetch, () => 130000);
  const dl = (await down.node('hyper-a')).split('\n');
  assert.equal(dl[0], 'hyper-a (hypersnap): down, timeout, checked 30s ago');
  assert.equal(dl.length, 3, 'no shard line and no stall line when down with no stalls');
});

test('failures do not fabricate numbers and are throttled for 30 seconds', async () => {
  let n = 0; let now = 0;
  const api = new Snapdiff((async () => { n++; throw Error('offline'); }) as typeof fetch, () => now);
  assert.equal(await api.summary(), 'snapdiff api unavailable\nhttps://snapdiff.schmidtiest.xyz');
  assert.equal(await api.status(), 'snapdiff api unavailable\nhttps://snapdiff.schmidtiest.xyz');
  assert.equal(n, 1);
  now = 30000; await api.fid(1);
  assert.equal(n, 2);
});

test('feedback: slash form anywhere, prose form only when addressed, capped, file is JSONL', () => {
  assert.equal(match({ ...base, text: '/feedback the fid lookup is great' })?.feedback, 'the fid lookup is great');
  assert.equal(match({ ...base, text: '/feedback@snapdiff_bot  spaced  ' })?.feedback, 'spaced');
  assert.equal(match({ ...base, text: 'feedback: not addressed' }), null);
  assert.equal(match({ ...base, privateChat: true, text: 'feedback: in a DM' })?.feedback, 'in a DM');
  assert.equal(match({ ...base, text: '/feedback ' + 'x'.repeat(2000) })?.feedback?.length, FEEDBACK_MAX);
  const file = join(mkdtempSync(join(tmpdir(), 'snapdiff-fb-')), 'feedback.jsonl');
  recordFeedback(file, { at: '2026-11-03T00:00:00.000Z', userId: 7, username: 'ryan', chatType: 'private', text: 'line one\nline two' });
  recordFeedback(file, { at: '2026-11-03T00:01:00.000Z', userId: 8, username: null, chatType: 'supergroup', text: 'y'.repeat(2000) });
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'line one\nline two');
  assert.equal(lines[1].text.length, FEEDBACK_MAX);
});
