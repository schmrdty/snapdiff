import { Bot } from 'grammy';
import { readFileSync, writeFileSync } from 'node:fs';
import { Snapdiff } from './snapdiff.ts';
import { match } from './trigger.ts';
import { forwardText, recordFeedback } from './feedback.ts';
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw Error('TELEGRAM_BOT_TOKEN required');
const bot = new Bot(token);
const service = new Snapdiff();
const muteFile = process.env.MUTE_FILE ?? './muted-users.json';
const feedbackFile = process.env.FEEDBACK_FILE ?? './feedback.jsonl';
const forwardTo = process.env.FEEDBACK_CHAT_ID || undefined;
// Operator-written line shown by /tip (an address and chain, or a link). Unset = not set up.
const tipText = process.env.TIP_TEXT?.trim() || 'tips are not set up yet';
const LIMIT_MS = 20_000;
const HELP: Record<string, string> = {
  help: 'commands: /snapdiff network summary, /status every node and client, /fid 123 open diffs for one FID, /feedback your note, /tip. Add "is <client> down" to /snapdiff to check one client. Reply "stop" to mute me for you.',
  snapdiff: 'usage: /snapdiff. Networks up, worst block delay, open diff counts. Add "is <client> down" to check one client.',
  status: 'usage: /status. Every node (up or down, block delay, which provider answered) and every watched client.',
  fid: 'usage: /fid 123, digits only. Lists open diffs for that FID: which nodes have each cast and which are missing it.',
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
  else body = await service.summary(t.client);
  await send(body);
});
bot.catch(() => console.error(new Date().toISOString(), 'telegram handler error'));
bot.start({ onStart: () => console.log(new Date().toISOString(), 'telegram polling started') });
