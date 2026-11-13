# Claude project for snapdiff operations

This folder holds the files for a Claude project (claude.ai, Projects) that answers simple questions and handles simple requests about snapdiff: what the dashboard shows, what a bot reply means, what a community member is asking, which one-line command to run. It is not for building features or changing the integration. That work stays in a Claude Code session on the repo.

Nothing in this folder is read by snapdiff at runtime. It is documentation for a person setting up the project and for the model inside it.

## Files

| File | Where it goes | Update when |
|---|---|---|
| `PROJECT-INSTRUCTIONS.md` | Paste into the project's "Instructions" box | The reply rules or boundaries change |
| `SNAPDIFF-FACTS.md` | Upload to project knowledge | A node, client, endpoint, version rule, or fork fact changes (it is dated at the top) |
| `COMMUNITY-FAQ.md` | Upload to project knowledge | A new recurring question appears in the group |
| `OPS-RUNBOOK.md` | Upload to project knowledge | A command, path, or unit name changes |

Also upload from the repo, unchanged: `README.md`, `docs/MULTI-NODE.md`, `docs/CLIENT-HEALTH.md`, `integrations/telegram/README.md`. They are the source the facts file summarizes; when they disagree, the repo file wins and the facts file needs an edit.

## Setup

1. Create a project named `snapdiff ops`.
2. Paste `PROJECT-INSTRUCTIONS.md` into Instructions.
3. Upload the four knowledge files listed above plus the four repo files.
4. First message to test it: `what does scope network mean on a stall row?` The answer must come from the facts file and end with a next step.

## What the project must never hold

1. Any `.env` content or value, the Telegram token, API keys, or the path of the token file's contents.
2. Private addresses of nodes marked private in the running config, or any home network detail.
3. Anything the repo's public mirror excludes.

## Refresh rule

The facts file carries an "as of" date. Re-upload it after every deploy that changes what the dashboard or bot shows, and after every Hypersnap or Snapchain release that changes a number quoted in it. A stale facts file produces confident wrong answers, which is worse than no answer.
