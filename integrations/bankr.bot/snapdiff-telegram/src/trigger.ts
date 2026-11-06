export type Input = { text?: string; privateChat: boolean; mentioned: boolean; replyToBot: boolean; invitedThread: boolean };
export type Trigger = { command: string; fid?: number; client?: string; stop?: boolean } | null;
export function match(input: Input): Trigger {
  const text = (input.text ?? '').slice(0, 500).trim();
  const invited = input.privateChat || input.mentioned || input.replyToBot || input.invitedThread;
  if (!invited && !/^\/(snapdiff|status|fid)(?:@\w+)?(?:\s|$)/i.test(text)) return null;
  if (/^stop[.!]?$/i.test(text) && invited) return { command: 'stop', stop: true };
  const cmd = text.match(/^\/(snapdiff|status|fid)(?:@\w+)?(?:\s+(\S+))?/i);
  if (cmd?.[1] === 'fid' && (!cmd[2] || !/^[1-9]\d{0,14}$/.test(cmd[2]) || !Number.isSafeInteger(Number(cmd[2])))) return null;
  const symptom = /\b(cast not showing|missing cast|can't see my cast|is\s+.{1,40}?\s+down)\b/i.test(text);
  if (!cmd && !(input.mentioned || input.replyToBot || input.invitedThread || input.privateChat) || !cmd && !/\bsnapdiff\b/i.test(text) && !symptom && !input.mentioned) return null;
  const client = text.match(/\bis\s+([\w .-]{1,40}?)\s+down\b/i)?.[1]?.trim();
  return { command: cmd?.[1] ?? 'mention', fid: cmd?.[1] === 'fid' ? Number(cmd[2]) : undefined, client };
}
