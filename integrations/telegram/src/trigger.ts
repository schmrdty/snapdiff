import { FEEDBACK_MAX } from './feedback.ts';
export type Input = { text?: string; privateChat: boolean; mentioned: boolean; replyToBot: boolean; invitedThread: boolean };
export type Trigger = { command: string; fid?: number; client?: string; node?: string; stop?: boolean; feedback?: string; help?: boolean } | null;
export const COMMANDS = ['snapdiff', 'status', 'fid', 'node', 'subscribe', 'unsubscribe', 'feedback', 'tip', 'help', 'start'] as const;
// Registered with Telegram at start so the "/" menu lists the commands. In a group the client
// appends @botname when a menu entry is tapped, and /command@botname is the one form Group
// Privacy always delivers; a bare /command reaches the bot only when it posted last in that group.
// Telegram limits: command 1 to 32 chars of [a-z0-9_], description 1 to 256 chars. /start is
// Telegram's own entry point and is left off the menu.
export const COMMAND_MENU: { command: string; description: string }[] = [
  { command: 'snapdiff', description: 'networks up, worst delay, open diff counts; add "is X down" for one node or client' },
  { command: 'status', description: 'every node and every watched client' },
  { command: 'fid', description: 'open diffs for one FID: /fid 123' },
  { command: 'node', description: 'one node now and over 24 h: /node LABEL' },
  { command: 'subscribe', description: 'node events by DM, private chat only: /subscribe LABEL' },
  { command: 'unsubscribe', description: 'stop following a node' },
  { command: 'feedback', description: 'a note to the operator' },
  { command: 'tip', description: 'where to send a tip toward node and server costs' },
  { command: 'help', description: 'the command list' },
];
// Node labels as snapdiff's env accepts them: letters, digits, dot, underscore, dash.
const LABEL = /^[\w.-]{1,40}$/;
const clientOf = (text: string) => text.match(/\bis\s+([\w .-]{1,40}?)\s+down\b/i)?.[1]?.trim();
export function match(input: Input): Trigger {
  const raw = (input.text ?? '').trim();
  // Slash commands work wherever Telegram delivers them. A blank or "help" argument
  // returns usage instead of silence, so a wrong command still gets an answer.
  const cmd = raw.match(/^\/(snapdiff|status|fid|node|subscribe|unsubscribe|feedback|tip|help|start)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (cmd) {
    const name = cmd[1]!.toLowerCase();
    const arg = (cmd[2] ?? '').trim();
    if (name === 'help' || name === 'start') return { command: 'help', help: true };
    if (/^help$/i.test(arg)) return { command: name, help: true };
    if (name === 'feedback') return arg ? { command: 'feedback', feedback: arg.slice(0, FEEDBACK_MAX) } : { command: 'feedback', help: true };
    if (name === 'fid') return /^[1-9]\d{0,14}$/.test(arg) && Number.isSafeInteger(Number(arg)) ? { command: 'fid', fid: Number(arg) } : { command: 'fid', help: true };
    if (name === 'node') return LABEL.test(arg) ? { command: 'node', node: arg } : { command: 'node', help: true };
    // No label: /subscribe lists the chat's subscriptions, /unsubscribe drops them all.
    if (name === 'subscribe' || name === 'unsubscribe') return arg === '' ? { command: name } : LABEL.test(arg) ? { command: name, node: arg } : { command: name, help: true };
    if (name === 'tip') return { command: 'tip' };
    return { command: name, client: clientOf(arg) };
  }
  // Plain text only when addressed: private chat, mention, reply to the bot, or an invited topic.
  const invited = input.privateChat || input.mentioned || input.replyToBot || input.invitedThread;
  if (!invited) return null;
  const fb = raw.match(/^feedback:\s*([\s\S]+)/i);
  if (fb) return { command: 'feedback', feedback: fb[1]!.trim().slice(0, FEEDBACK_MAX) };
  const text = raw.slice(0, 500);
  if (/^stop[.!]?$/i.test(text)) return { command: 'stop', stop: true };
  if (/^help$/i.test(text)) return { command: 'help', help: true };
  const symptom = /\b(cast not showing|missing cast|can't see my cast|is\s+.{1,40}?\s+down)\b/i.test(text);
  if (!/\bsnapdiff\b/i.test(text) && !symptom && !input.mentioned) return null;
  return { command: 'mention', client: clientOf(text) };
}
