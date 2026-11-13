import { Bot } from 'grammy';
import { readFileSync, writeFileSync } from 'node:fs';
import { Snapdiff, DASHBOARD } from './snapdiff.ts';
import { match } from './trigger.ts';
import { forwardText, recordFeedback } from './feedback.ts';
import { SubStore, diffEvents, allow, POLL_MS, MAX_LABELS_PER_CHAT, MAX_SENDS_PER_TICK, type NodeState } from './subscriptions.ts';
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw Error('TELEGRAM_BOT_TOKEN required');
const bot = new Bot(token);
const service = new Snapdiff();
const muteFile = process.env.MUTE_FILE ?? './muted-users.json';
const feedbackFile = process.env.FEEDBACK_FILE ?? './feedback.jsonl';
const forwardTo = process.env.FEEDBACK_CHAT_ID || undefined;
// Operator-written line shown by /tip (an address and chain, or a link). Unset = not set up.
const tipText = process.env.TIP_TEXT?.trim() || 'tips are not set up yet';
// Subscriptions live in the unit's StateDirectory by default (systemd exports STATE_DIRECTORY);
// the working directory is read-only under ProtectSystem=strict.
const subsFile = process.env.SUBSCRIPTIONS_FILE ?? `${process.env.STATE_DIRECTORY ?? '.'}/subscriptions.json`;
const subs = new SubStore(subsFile);
const LIMIT_MS = 20_000;
const HELP: Record<string, string> = {
  help: 'commands: /snapdiff network summary, /status every node and client, /fid 123 open diffs for one FID, /node LABEL one node over 24 h, /subscribe LABEL node events by DM, /unsubscribe, /feedback your note, /tip. Add "is <client> down" to /snapdiff to check one client. Reply "stop" to mute me for you.',
  snapdiff: 'usage: /snapdiff. Networks up, worst block delay, open diff counts. Add "is <client> down" to check one client.',
  status: 'usage: /status. Every node (up or down, block delay, which provider answered) and every watched client.',
  fid: 'usage: /fid 123, digits only. Lists open diffs for that FID: which nodes have each cast and which are missing it.',
  node: 'usage: /node LABEL, the label as /status prints it. That node now, its last 24 h (checks, uptime, worst delay, stalls), shard heights, and its newest stall.',
  subscribe: `usage: /subscribe LABEL, in a private chat with me. I message you when that node goes down, comes back, a shard stalls or recovers, or its version falls behind the newest on its network (checked once a minute, one message per event type per 10 min). Up to ${MAX_LABELS_PER_CHAT} nodes per chat. /subscribe alone lists yours.`,
  unsubscribe: 'usage: /unsubscribe LABEL to stop following one node, /unsubscribe alone to stop all.',
  feedback: 'usage: /feedback your note. Goes to the operator. This is the only message text the bot keeps.',
  tip: 'usage: /tip. Shows where to send a tip toward node and server costs, once the operator has set one up.',
  mention: '',
};
let muted: Set<number>;
try { muted = new Set(JSON.parse(readFileSync(muteFile, 'utf8')) as number[]); } catch { muted = new Set(); }
const last = new Map<number, number>();
const warned = new Map<number, number>();
const invited = new Map<string, number>();
const thread = (chat: number, id?: number) => `${chat}:${id ?? 0}`;
bot.on('message:text', async ctx => {
  const m = ctx.message, from = m.from;
  if (!from || m.sender_chat || m.is_automatic_forward) return;
  const me = ctx.me.username.toLowerCase();
  const target = m.text.match(/^\/\w+@([\w]+)\b/)?.[1]?.toLowerCase();
  if (target && target !== me) return;
  const direct = m.chat.type === 'private';
  const reply = m.reply_to_message?.from?.id === ctx.me.id;
  const mentioned = m.entities?.some(e => e.type === 'mention' && m.text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${me}`) ?? false;
  const topic = thread(m.chat.id, m.message_thread_id);
  const now = Date.now();
  const t = match({ text: m.text, privateChat: direct, replyToBot: reply, mentioned, invitedThread: (invited.get(topic) ?? 0) > now && !!m.message_thread_id });
  if (!t) return;
  console.log(new Date(now).toISOString(), t.command + (t.help ? ' help' : ''));
  const send = (body: string) => ctx.reply(body, { reply_parameters: { message_id: m.message_id }, link_preview_options: { is_disabled: true } });
  if (t.stop) {
    muted.add(from.id);
    writeFileSync(muteFile, JSON.stringify([...muted]), { mode: 0o600 });
    return;
  }
  // One answer per user per LIMIT_MS. The first dropped request in a window gets a
  // one-line notice so silence is never the only signal; the rest are dropped.
  const since = now - (last.get(from.id) ?? 0);
  if (since < LIMIT_MS) {
    if ((warned.get(from.id) ?? 0) < (last.get(from.id) ?? 0)) { warned.set(from.id, now); await send(`one request every ${LIMIT_MS / 1000} s, try again in ${Math.ceil((LIMIT_MS - since) / 1000)} s`); }
    return;
  }
  if (muted.has(from.id) && t.command !== 'feedback') return;
  last.set(from.id, now);
  if (m.message_thread_id && (mentioned || reply || t.command !== 'mention')) invited.set(topic, now + 24 * 60 * 60_000);
  let body: string;
  if (t.help) body = HELP[t.command] || HELP.help!;
  else if (t.command === 'feedback') {
    const entry = { at: new Date(now).toISOString(), userId: from.id, username: from.username ?? null, chatType: m.chat.type, text: t.feedback ?? '' };
    recordFeedback(feedbackFile, entry);
    if (forwardTo) await bot.api.sendMessage(forwardTo, forwardText(entry), { link_preview_options: { is_disabled: true } }).catch(() => console.error(new Date().toISOString(), 'feedback forward failed'));
    body = 'thanks, noted';
  }
  else if (t.command === 'tip') body = tipText;
  else if (t.command === 'status') body = await service.status();
  else if (t.command === 'fid') body = await service.fid(t.fid!);
  else if (t.command === 'node') body = await service.node(t.node!);
  else if (t.command === 'subscribe' || t.command === 'unsubscribe') body = await subscribeReply(t.command, m.chat.id, direct, t.node);
  else body = await service.summary(t.client);
  await send(body);
});
bot.catch(() => console.error(new Date().toISOString(), 'telegram handler error'));

async function subscribeReply(command: string, chat: number, direct: boolean, label?: string): Promise<string> {
  if (!direct) return 'subscriptions work in a private chat with me only, so a group is never flooded';
  if (command === 'unsubscribe') {
    const n = subs.remove(chat, label);
    if (label !== undefined) return n ? `stopped following ${label}` : `you were not following ${label}`;
    return n ? `stopped following ${n} node${n === 1 ? '' : 's'}` : 'you follow nothing';
  }
  if (label === undefined) {
    const mine = subs.list(chat);
    return mine.length ? `you follow: ${mine.join(', ')}. /unsubscribe LABEL to stop one.` : HELP.subscribe!;
  }
  const nodes = await service.nodeList();
  if (!nodes) return 'snapdiff api unavailable, try again in a minute';
  if (!nodes.includes(label)) return `${label}: not a listed node, /status lists them`;
  const r = subs.add(chat, label);
  if (r === 'added') return `following ${label}: I will message you here when it goes down, comes back, a shard stalls or recovers, or its version falls behind`;
  if (r === 'already') return `you already follow ${label}`;
  if (r === 'chat-full') return `you already follow ${MAX_LABELS_PER_CHAT} nodes, /unsubscribe one first`;
  return 'the bot has reached its subscriber limit for now, ask the operator';
}

// Poller: nothing runs while nobody subscribes. One state fetch per minute, events only on
// transitions, bundled into one message per chat, capped per tick. A 403 from Telegram
// means the person blocked the bot: that chat is dropped so it never retries.
const seen = new Map<string, NodeState>();
const quiet = new Map<string, number>();
let polling = false;
async function pollEvents(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const labels = subs.labels();
    for (const k of [...seen.keys()]) if (!labels.includes(k)) seen.delete(k);
    if (!labels.length) return;
    const states = await service.nodeStates(labels);
    if (!states) return;
    const now = Date.now();
    const perChat = new Map<number, string[]>();
    for (const [label, next] of states) {
      const events = diffEvents(label, seen.get(label), next).filter(e => allow(quiet, e, now));
      seen.set(label, next);
      // Same text once per chat: a network-wide pause is worded without the label, so two followed nodes of one network produce one line.
      for (const e of events) for (const chat of subs.chatsFor(label)) { const cur = perChat.get(chat) ?? []; if (!cur.includes(e.text)) perChat.set(chat, [...cur, e.text]); }
    }
    let sent = 0;
    for (const [chat, lines] of perChat) {
      if (sent >= MAX_SENDS_PER_TICK) break;
      sent++;
      try { await bot.api.sendMessage(chat, [...lines, DASHBOARD].join('\n'), { link_preview_options: { is_disabled: true } }); }
      catch (e) { if ((e as { error_code?: number }).error_code === 403) subs.remove(chat); }
    }
    if (sent) console.log(new Date(now).toISOString(), `events: ${sent} chat${sent === 1 ? '' : 's'} notified`);
  } catch { console.error(new Date().toISOString(), 'event poll error'); }
  finally { polling = false; }
}
setInterval(() => void pollEvents(), POLL_MS).unref();
bot.start({ onStart: () => console.log(new Date().toISOString(), 'telegram polling started') });
