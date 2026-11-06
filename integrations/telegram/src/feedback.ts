import { appendFileSync } from 'node:fs';
// The feedback file is the only place this bot stores message text. Kept small and local
// (systemd StateDirectory), one JSON object per line, so it can be read with any tool.
// Handles are optional on Telegram and can change; the numeric id is the stable key, so both are kept.
export type Feedback = { at: string; userId: number; username: string | null; chatType: string; text: string };
export const FEEDBACK_MAX = 1000;
export function recordFeedback(file: string, entry: Feedback): void {
  appendFileSync(file, JSON.stringify({ ...entry, text: entry.text.slice(0, FEEDBACK_MAX) }) + '\n', { mode: 0o600 });
}
export const forwardText = (e: Feedback): string => `snapdiff feedback from ${e.username ? `@${e.username} (id ${e.userId}, ${e.chatType})` : `user ${e.userId} (${e.chatType})`}:\n${e.text}`;
