# snapdiff Telegram status bot
Read-only bot for the existing dashboard: https://snapdiff.schmidtiest.xyz. Node 24, TypeScript, grammY only; the shared client in `src/snapdiff.ts` has no Telegram imports. Polls Telegram using getUpdates; no web server, webhook, timer or outbound DM initiation.

## Setup
Create a bot with BotFather. Enable group joining; set privacy mode **on**. Telegram API scopes are the bot token only (no OAuth scopes). Telegram permissions: receive private messages initiated by users, slash commands, @mentions, and replies to bot messages in groups/topics; send messages in the group/topic. No admin rights, read-history, channel-posting, or DM permissions needed. Add bot to the intended groups. Use `/snapdiff`, `/status`, `/fid 123`; mentions and replies to the bot also work, as do symptom phrases in an invited topic. Telegram cannot infer a Farcaster FID from Telegram identity; use `/fid N`.

Install Node 24 and run `npm ci`; `npm run check && npm test`. Copy `.env.example` to `/etc/snapdiff-telegram.env`, set TELEGRAM_BOT_TOKEN, chmod 600. The file is systemd EnvironmentFile syntax, not read by the program directly. Install repo under `/opt/snapdiff-telegram`; create service user `snapdiff-bot`; copy unit to `/etc/systemd/system/`, run `systemctl daemon-reload && systemctl enable --now snapdiff-telegram`. Set `MUTE_FILE=/var/lib/snapdiff-telegram/muted-users.json` (systemd StateDirectory owns this path). Never commit secrets.

Snapdiff read endpoints are public. Every request sends `User-Agent: snapdiff-telegram/1.0.0` (derived from package.json). Source: `/api/summary`, `/api/diffs?limit=5000`, `/api/clients`, `/api/stalls`, no other URLs. `/api/diffs` supports omitted `cause`; this gets all causes in one request for a client-side FID filter. API limit 5000, newest-first: if truncated, “no open diffs in latest 5000 rows” is not a guarantee of zero overall. Old records can have null scope; reported as unknown rather than guessed.

Each endpoint has a separate 30s in-process success cache, a 30s failure cooldown, and in-flight deduplication. No timer; idle fetches zero. Replies show at most two matching diff rows and, when there is no client lookup, one overflow count; the last line is always the existing dashboard URL. Summary is always requested; diffs only with `/fid`, clients only with `is CLIENT down`, stalls only if summary says openStalls > 0. One request per needed endpoint per cache window in this single process. Errors yield “snapdiff api unavailable” rather than fabricated metrics. User replies are limited to one per 60s in process; a restart resets that limit. `stop` in a private chat, mention, or reply to bot persists the Telegram user ID to the mute file; removing an ID there and restarting unmutes. Text is never stored or logged; only timestamps, command names and generic errors. Group privacy means the bot cannot see arbitrary discussion; topic invitation only applies to messages Telegram actually delivers. The only outbound link is the dashboard URL, with link previews disabled.

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
