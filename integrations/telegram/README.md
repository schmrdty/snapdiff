# snapdiff Telegram status bot
Read-only bot for the existing dashboard: https://snapdiff.schmidtiest.xyz. Node 24, TypeScript, grammY only; the shared client in `src/snapdiff.ts` has no Telegram imports. Polls Telegram using getUpdates; no web server, webhook, timer or outbound DM initiation.

## Setup
Create a bot with BotFather. Enable group joining; set privacy mode **on**. Telegram API scopes are the bot token only (no OAuth scopes). Telegram permissions: receive private messages initiated by users, slash commands, @mentions, and replies to bot messages in groups/topics; send messages in the group/topic. No admin rights, read-history, channel-posting, or DM permissions needed. Add bot to the intended groups. Commands: `/snapdiff` (networks up, worst delay, open diff counts; add "is <client> down" for one client), `/status` (every node with network, up or down, block delay, answering provider; every watched client; open stalls), `/fid 123` (only that FID's open diffs, or the lack of them), `/feedback <text>`, `/tip`, `/help` (also `/start`). A command with a blank or "help" argument answers with its usage. Mentions and replies to the bot also work, as do symptom phrases in an invited topic. Telegram cannot infer a Farcaster FID from Telegram identity; use `/fid N`.

Install Node 24 and run `npm ci`; `npm run check && npm test`. Copy `.env.example` to `/etc/snapdiff-telegram.env`, set TELEGRAM_BOT_TOKEN, chmod 600. The file is systemd EnvironmentFile syntax, not read by the program directly. Install repo under `/opt/snapdiff-telegram`; create service user `snapdiff-bot`; copy unit to `/etc/systemd/system/`, run `systemctl daemon-reload && systemctl enable --now snapdiff-telegram`. Set `MUTE_FILE=/var/lib/snapdiff-telegram/muted-users.json` (systemd StateDirectory owns this path). Never commit secrets.

Snapdiff read endpoints are public. Every request sends `User-Agent: snapdiff-telegram/1.0.0` (derived from package.json). Source: `/api/summary`, `/api/diffs?limit=5000`, `/api/clients`, `/api/stalls`, no other URLs. `/api/diffs` supports omitted `cause`; this gets all causes in one request for a client-side FID filter. API limit 5000, newest-first: if truncated, “no open diffs in latest 5000 rows” is not a guarantee of zero overall. Old records can have null scope; reported as unknown rather than guessed.

Each endpoint has a separate 30s in-process success cache, a 30s failure cooldown, and in-flight deduplication. No timer; idle fetches zero. Replies show at most two matching diff rows and, when there is no client lookup, one overflow count; the last line is always the existing dashboard URL. `/snapdiff` requests summary (plus stalls when openStalls > 0, plus clients for "is CLIENT down"); `/status` requests summary, clients, and stalls when open; `/fid` requests diffs only. One request per needed endpoint per cache window in this single process. Errors yield “snapdiff api unavailable” rather than fabricated metrics. Replies are limited to one per user every 20 s in process; the first dropped request in a window gets a one-line notice, later ones are dropped silently; a restart resets that limit. `/tip` replies with the operator-written `TIP_TEXT` line (an address and chain, or a link), or "tips are not set up yet" when unset. `stop` in a private chat, mention, or reply to bot persists the Telegram user ID to the mute file; removing an ID there and restarting unmutes. Text is never stored or logged; only timestamps, command names and generic errors. Group privacy means the bot cannot see arbitrary discussion; topic invitation only applies to messages Telegram actually delivers. The only outbound link is the dashboard URL, with link previews disabled.

## Feedback
`/feedback <text>` in any chat the bot can see, or `feedback: <text>` when addressed, appends one JSON line `{at, userId, username, chatType, text}` to `FEEDBACK_FILE` (default `./feedback.jsonl`; set `/var/lib/snapdiff-telegram/feedback.jsonl` under the unit's StateDirectory, mode 0600) and replies "thanks, noted". This file is the only place the bot stores message text; text is capped at 1000 characters. When `FEEDBACK_CHAT_ID` is set, the same text is also sent to that chat (the operator's own DM with the bot). Muted users may still send feedback; the 20 s per-user limit applies. `/feedback` with no text replies with usage. The forwarded copy names the sender as `@handle (id N, chat type)`, or `user N` when the account has no handle. Read the file with `jq -r '.at + " " + (.userId|tostring) + " " + .text' feedback.jsonl`.

## Runtime dependency tree (package-lock.json)

- @grammyjs/types 3.22.1
- abort-controller 3.0.0
- debug 4.4.3
- event-target-shim 5.0.1
- grammy 1.38.0
- ms 2.1.3
- node-fetch 2.7.0
- tr46 0.0.3
- webidl-conversions 3.0.1
- whatwg-url 5.0.0

These are all installed production packages in this lockfile; optional peers not installed are excluded. Run `npm ls --all --omit=dev` after `npm ci` to audit the installed tree. Node 24 supplies the runtime.
