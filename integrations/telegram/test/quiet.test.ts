import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allow, loadQuiet, saveQuiet, QUIET_MS, type Event } from '../src/subscriptions.ts';

const e: Event = { label: 'astrix', kind: 'down', text: 'astrix (hypersnap): down' };
const dir = () => mkdtempSync(join(tmpdir(), 'quiet-'));

test('quiet timers survive a restart: an event inside the window stays silent after reload', () => {
  const file = join(dir(), 'quiet.json');
  const before = new Map<string, number>();
  assert.equal(allow(before, e, 1_000), true);
  saveQuiet(file, before, 1_000);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const after = loadQuiet(file, 2_000);
  assert.equal(allow(after, e, 2_000), false, 'same label and kind still silenced after the reload');
  assert.equal(allow(after, { ...e, kind: 'up' }, 2_000), true, 'other kinds are unaffected');
  assert.equal(allow(loadQuiet(file, 1_000 + QUIET_MS), e, 1_000 + QUIET_MS), true, 'the window still ends on time');
});

test('loadQuiet: missing or corrupt file is empty; expired, bad keys, and far-future expiries are dropped', () => {
  const d = dir();
  assert.equal(loadQuiet(join(d, 'none.json'), 0).size, 0);
  const bad = join(d, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(loadQuiet(bad, 0).size, 0);
  writeFileSync(bad, '[1,2]');
  assert.equal(loadQuiet(bad, 0).size, 0);
  const mixed = join(d, 'mixed.json');
  writeFileSync(mixed, JSON.stringify({ 'astrix:down': 500, 'snape:up': 2_000, 'bad key!:down': 2_000, 'fred:stall': 'soon', 'jamal:behind': 10 * QUIET_MS }));
  assert.deepEqual([...loadQuiet(mixed, 1_000)], [['snape:up', 2_000]]);
});

test('saveQuiet prunes expired entries and writes only keys and times', () => {
  const file = join(dir(), 'quiet.json');
  const q = new Map([['astrix:down', 500], ['snape:up', 2_000]]);
  saveQuiet(file, q, 1_000);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'snape:up': 2_000 });
  assert.equal(q.has('astrix:down'), false);
});
