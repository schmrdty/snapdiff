import { Bot } from 'grammy';
import { readFileSync, writeFileSync } from 'node:fs';
import { Snapdiff } from './snapdiff.ts';
import { match } from './trigger.ts';
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw Error('TELEGRAM_BOT_TOKEN required');
const bot = new Bot(token);
const service = new Snapdiff();
const muteFile = process.env.MUTE_FILE ?? './muted-users.json';
let muted: Set<number>;
try { muted = new Set(JSON.parse(readFileSync(muteFile, 'utf8')) as number[]); } catch { muted = new Set(); }
const last = new Map<number, number>();
const invited = new Map<string, number>();
const thread = (chat: number, id?: number) => `${chat}:${id ?? 0}`;
bot.on('message:text', async ctx => {
  const m = ctx.message, from = m.from;
  if (!from || m.sender_chat || m.is_automatic_forward) return;
  const me = ctx.me.username.toLowerCase();
  const target = m.text.match(/^\/(?:snapdiff|status|fid)@([\w]+)\b/i)?.[1]?.toLowerCase();
  if (target && target !== me) return;
  const direct = m.chat.type === 'private';
  const reply = m.reply_to_message?.from?.id === ctx.me.id;
  const mentioned = m.entities?.some(e => e.type === 'mention' && m.text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${me}`) ?? false;
  const topic = thread(m.chat.id, m.message_thread_id);
  const now = Date.now();
  const t = match({ text: m.text, privateChat: direct, replyToBot: reply, mentioned, invitedThread: (invited.get(topic) ?? 0) > now && !!m.message_thread_id });
  if (!t) return;
  console.log(new Date(now).toISOString(), t.command);
  if (t.stop) {
    muted.add(from.id);
    writeFileSync(muteFile, JSON.stringify([...muted]), { mode: 0o600 });
    return;
  }
  if (muted.has(from.id) || now - (last.get(from.id) ?? 0) < 60000) return;
  last.set(from.id, now);
  if (m.message_thread_id && (mentioned || reply || t.command !== 'mention')) invited.set(topic, now + 24 * 60 * 60_000);
  const body = await service.report(t.fid, t.client);
  await ctx.reply(body, { reply_parameters: { message_id: m.message_id }, link_preview_options: { is_disabled: true } });
});
bot.catch(() => console.error(new Date().toISOString(), 'telegram handler error'));
bot.start({ onStart: () => console.log(new Date().toISOString(), 'telegram polling started') });
