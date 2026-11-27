import { readFileSync, writeFileSync, renameSync } from 'node:fs';
// Event subscriptions: a private chat asks to be told when a node changes state. Deliberately
// small for the first release (operator, 2026-11-10: "limit them heavily for now"):
//   - private chats only, so a group can never be flooded by one member's choice;
//   - at most MAX_LABELS_PER_CHAT labels per chat and MAX_CHATS chats in total;
//   - one poll a minute against the public API, and no poll at all while nobody subscribes;
//   - ten event kinds only (down, back up, shard stalled, stall ended, left behind when the
//     rest of the network moves again, version behind, version current again, release
//     published while the node runs something older, and since 2026-11-25 degraded and
//     caught up, the dashboard's yellow pill for a node that answers but is behind), each silenced
//     per label for QUIET_MS after it fires, and at most MAX_SENDS_PER_TICK messages per poll.
//     A stall on every node of the network is worded as the network's pause, without the
//     label, so a chat following two nodes of one network reads it once.
// The file holds chat ids and labels, nothing else (no names, no text).
// 7 since 2026-11-22 (operator): three was too few to follow one operator's nodes plus the
// reference nodes; the per-poll send cap and the quiet period still bound the volume.
export const MAX_LABELS_PER_CHAT = 7;
export const MAX_CHATS = 25;
export const POLL_MS = 60_000;
export const QUIET_MS = 10 * 60_000;
export const MAX_SENDS_PER_TICK = 20;

export type Subs = Record<string, string[]>;
const LABEL = /^[\w.-]{1,40}$/;

function sanitize(raw: unknown): Subs {
  const out: Subs = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [chat, labels] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^-?\d{1,20}$/.test(chat) || !Array.isArray(labels)) continue;
    const clean = [...new Set(labels.filter((l): l is string => typeof l === 'string' && LABEL.test(l)))].slice(0, MAX_LABELS_PER_CHAT);
    if (clean.length) out[chat] = clean;
  }
  return out;
}

export class SubStore {
  private subs: Subs;
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    try { this.subs = sanitize(JSON.parse(readFileSync(file, 'utf8'))); } catch { this.subs = {}; }
  }
  /** Labels one chat follows, in the order they were added. */
  list(chat: number): string[] { return [...(this.subs[String(chat)] ?? [])]; }
  /** Every distinct label anyone follows: what the poller has to look at. */
  labels(): string[] { return [...new Set(Object.values(this.subs).flat())]; }
  /** Chats following one label. */
  chatsFor(label: string): number[] { return Object.entries(this.subs).filter(([, ls]) => ls.includes(label)).map(([c]) => Number(c)); }
  chats(): number { return Object.keys(this.subs).length; }
  add(chat: number, label: string): 'added' | 'already' | 'chat-full' | 'bot-full' {
    const key = String(chat);
    const mine = this.subs[key] ?? [];
    if (mine.includes(label)) return 'already';
    if (mine.length >= MAX_LABELS_PER_CHAT) return 'chat-full';
    if (!this.subs[key] && this.chats() >= MAX_CHATS) return 'bot-full';
    this.subs[key] = [...mine, label];
    this.save();
    return 'added';
  }
  /** Without a label: drop everything for that chat. Returns how many labels were removed. */
  remove(chat: number, label?: string): number {
    const key = String(chat);
    const mine = this.subs[key] ?? [];
    const keep = label === undefined ? [] : mine.filter(l => l !== label);
    if (keep.length === mine.length) return 0;
    if (keep.length) this.subs[key] = keep; else delete this.subs[key];
    this.save();
    return mine.length - keep.length;
  }
  private save(): void {
    // Write then rename, so a crash mid-write never leaves a truncated file behind.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.subs), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export type NodeState = { /** Dashboard name (NODE_<K>_NAME), else absent and the label is printed. */ name?: string; /** The dashboard's degraded verdict (answering, but behind or stalled); null or absent when the API does not say. */ degraded?: boolean | null; /** Worst block delay in seconds while answering. */ delay?: number | null; network: string; reachable: boolean | null; error: string | null; stalledShards: number[]; /** Subset of stalledShards whose stall is the whole network's (scope "network" on /api/stalls). */ networkStalledShards: number[]; version: string | null; latestVersion: string | null; /** Newest version the project has published for this network (/api/summary releases), null when unknown or off. */ published: string | null };
export type EventKind = 'down' | 'up' | 'stall' | 'stall-ended' | 'left-behind' | 'behind' | 'current' | 'release' | 'degraded' | 'caught-up';
/** The dashboard's delay format (seconds, minutes, hours); kept local because the bot is its own package. */
const fmtDelay = (sec: number): string => (sec < 120 ? `${sec}s` : sec < 7200 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`);
const delayPart = (s: NodeState) => (typeof s.delay === 'number' ? `, delay ${fmtDelay(s.delay)}` : '');
export type Event = { label: string; kind: EventKind; text: string };

/** Numeric dot-part order ("0.17.5" > "0.17.4"); the same rule as snapdiff's src/versions.ts, kept local because the bot is its own package. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) { if (nx !== ny) return nx < ny ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
/** The node reports a version and it is older than the newest on its network. */
export const isBehind = (s: NodeState): boolean => s.version !== null && s.latestVersion !== null && compareVersions(s.version, s.latestVersion) < 0;

/** State transitions between two polls. The first observation of a label is a baseline and yields nothing. */
export function diffEvents(label: string, prev: NodeState | undefined, next: NodeState): Event[] {
  if (!prev) return [];
  const out: Event[] = [];
  const who = `${next.name ?? label} (${next.network})`;
  if (prev.reachable === true && next.reachable === false) out.push({ label, kind: 'down', text: `${who}: down${next.error ? `, ${next.error}` : ''}` });
  // A node that comes back behind (a restart, catching up) says so, as its yellow pill does.
  if (prev.reachable === false && next.reachable === true) out.push({ label, kind: 'up', text: `${who}: back up${next.degraded === true ? `, still catching up${delayPart(next)}` : ''}` });
  // Degraded and caught up, while answering on both polls. A stall has its own events, so these
  // fire only when no shard of the node is stalled (operator, 2026-11-25).
  if (prev.reachable === true && next.reachable === true && prev.degraded === false && next.degraded === true && next.stalledShards.length === 0) out.push({ label, kind: 'degraded', text: `${who}: degraded, answering but behind${delayPart(next)}` });
  if (prev.reachable === true && next.reachable === true && prev.degraded === true && next.degraded === false && prev.stalledShards.length === 0) out.push({ label, kind: 'caught-up', text: `${who}: caught up${delayPart(next)}` });
  const netWide = (st: NodeState, s: number) => st.networkStalledShards.includes(s);
  for (const s of next.stalledShards) if (!prev.stalledShards.includes(s)) out.push({ label, kind: 'stall', text: netWide(next, s) ? `${next.network}: shard ${s} stopped on every node (network-wide pause)` : `${who}: shard ${s} stalled` });
  for (const s of prev.stalledShards) if (!next.stalledShards.includes(s)) out.push({ label, kind: 'stall-ended', text: netWide(prev, s) ? `${next.network}: shard ${s} moving again on every node` : `${who}: shard ${s} stall ended` });
  // The network recovered but this node did not: from here on it is the node's own stall.
  for (const s of prev.networkStalledShards) if (next.stalledShards.includes(s) && !netWide(next, s)) out.push({ label, kind: 'left-behind', text: `${who}: still stalled on shard ${s} while the rest of ${next.network} moves again` });
  // Version drift: fires when the node first reads behind (its own upgrade lagging, or a peer
  // moving ahead), again whenever the gap changes while it stays behind (the newest moved on,
  // or the node upgraded part way), and once more when it is current again. Without the middle
  // case a node behind on 0.17.6 heard nothing when 0.17.7 shipped (2026-11-13). Unknown versions never fire.
  if (!isBehind(prev) && isBehind(next)) out.push({ label, kind: 'behind', text: `${who}: version ${next.version} is behind, newest on ${next.network} is ${next.latestVersion}` });
  else if (isBehind(prev) && isBehind(next) && (prev.version !== next.version || prev.latestVersion !== next.latestVersion)) out.push({ label, kind: 'behind', text: `${who}: version ${next.version} is still behind, newest on ${next.network} is now ${next.latestVersion}` });
  if (isBehind(prev) && !isBehind(next) && next.version !== null) out.push({ label, kind: 'current', text: `${who}: version ${next.version}, current again` });
  // Release published: the project pushed a newer version than this node runs. Fires once per
  // new published version, the earlier signal than "behind", which waits for a peer to upgrade.
  // Operator, 2026-11-14: four patches in one afternoon and nothing said so until a peer pulled each.
  // A node already on the published version hears nothing; an unknown node version still fires.
  if (next.published !== null && (prev.published === null || compareVersions(next.published, prev.published) > 0) && (next.version === null || compareVersions(next.version, next.published) < 0)) out.push({ label, kind: 'release', text: `${next.network} ${next.published} published, ${label} runs ${next.version ?? 'an unknown version'}` });
  return out;
}

/** One message per label and kind per QUIET_MS. Returns true when the event may be sent now. */
export function allow(quiet: Map<string, number>, e: Event, now: number): boolean {
  const key = `${e.label}:${e.kind}`;
  if ((quiet.get(key) ?? 0) > now) return false;
  quiet.set(key, now + QUIET_MS);
  return true;
}

// The quiet timers are kept on disk so a restart (a deploy, a crash) does not reopen every
// window: before 2026-11-25 a node flapping across a restart was announced again at once
// (operator, 2026-11-25: "I need the quiet timers that stop alerts repeating"). The file holds
// "label:kind" keys and expiry times in ms, nothing else. Expired entries are dropped on load
// and on save, and an expiry further out than QUIET_MS is treated as corrupt and ignored.
const QUIET_KEY = /^[\w.-]{1,40}:[a-z-]{1,16}$/;
export function loadQuiet(file: string, now: number): Map<string, number> {
  const out = new Map<string, number>();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return out; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (QUIET_KEY.test(k) && typeof v === 'number' && Number.isFinite(v) && v > now && v <= now + QUIET_MS) out.set(k, v);
  }
  return out;
}
export function saveQuiet(file: string, quiet: Map<string, number>, now: number): void {
  for (const [k, v] of quiet) if (v <= now) quiet.delete(k);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(quiet)), { mode: 0o600 });
  renameSync(tmp, file);
}
