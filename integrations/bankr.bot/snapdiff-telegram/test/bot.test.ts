import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { Snapdiff } from '../src/snapdiff.ts';
import { match } from '../src/trigger.ts';
import pkg from '../package.json' with { type: 'json' };
const sample = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url), 'utf8'));
test('trigger gate and FID validation', () => {
  const base = { privateChat: false, mentioned: false, replyToBot: false, invitedThread: false };
  assert.equal(match({ ...base, text: 'cast not showing' }), null);
  assert.equal(match({ ...base, replyToBot: true, text: "can't see my cast" })?.command, 'mention');
  assert.equal(match({ ...base, text: '/fid 123' })?.fid, 123);
  assert.equal(match({ ...base, text: '/fid 999999999999999999999' }), null);
  assert.equal(match({ ...base, mentioned: true, text: 'stop' })?.stop, true);
  assert.equal(match({ ...base, text: 'is Quilcast down' }), null);
  assert.equal(match({ ...base, replyToBot: true, text: 'is Quilcast down' })?.client, 'Quilcast');
});
test('formatter, endpoint gating, cache, and no untrusted links', async () => {
  let calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('User-Agent'), `snapdiff-telegram/${pkg.version}`);
    assert.equal(new Headers(init?.headers).has('x-api-key'), false);
    const key = new URL(url).pathname.split('/').at(-1)!;
    calls.push(key);
    return { ok: true, json: async () => sample[key] } as Response;
  }) as typeof fetch;
  const api = new Snapdiff(fetcher, () => 130000);
  const one = await api.report(123, 'Quilcast');
  assert.match(one, /snapchain 1\/1 up, worst delay 2s; hypersnap 1\/2 up, worst delay 6s/);
  assert.match(one, /unexplained: node 1, network 1; pending 1; stalls 1/);
  assert.match(one, /scope network, unexplained/);
  assert.match(one, /Quilcast: degraded, latency 210ms, checked 30s ago/);
  assert.equal(one.split('\n').length, 5);
  assert.ok(!one.includes('evil.example'));
  await api.report(99, 'Quilcast');
  assert.deepEqual(calls.sort(), ['clients', 'diffs', 'stalls', 'summary']);
});
test('no FID or client only calls summary, failures do not fabricate numbers', async () => {
  const seen: string[] = [];
  const ok = new Snapdiff((async url => { seen.push(String(url)); return { ok: true, json: async () => ({ ...sample.summary, summary: { ...sample.summary.summary, openStalls: 0 } }) } as Response; }) as typeof fetch);
  assert.match(await ok.report(), /stalls 0/);
  assert.equal(seen.length, 1);
  const fail = new Snapdiff((async () => { throw Error('offline'); }) as typeof fetch);
  assert.equal(await fail.report(), 'snapdiff api unavailable\nhttps://snapdiff.schmidtiest.xyz');
});

test('failed endpoint throttled for 30 seconds', async () => {
  let n = 0; let now = 0;
  const api = new Snapdiff((async () => { n++; throw Error('offline'); }) as typeof fetch, () => now);
  await api.report(); await api.report();
  assert.equal(n, 1);
  now = 30000; await api.report();
  assert.equal(n, 2);
});

test('format never exceeds six lines with overflow', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ...sample.diffs[0], hash: `0xabcdef${i}000000000` }));
  const api = new Snapdiff((async url => {
    const endpoint = new URL(String(url)).pathname.split('/').at(-1);
    return { ok: true, json: async () => endpoint === 'diffs' ? rows : sample[endpoint!] } as Response;
  }) as typeof fetch);
  const text = await api.report(123);
  assert.equal(text.split('\n').length, 6);
  assert.ok(text.includes('8 more open diffs'));
  const both = await api.report(123, 'Quilcast');
  assert.equal(both.split('\n').length, 6);
  assert.ok(both.includes('Quilcast: degraded'));
});
