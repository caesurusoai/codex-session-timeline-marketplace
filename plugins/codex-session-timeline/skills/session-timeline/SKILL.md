---
name: session-timeline
description: Use when the user wants to visualize, inspect, open, or debug a Codex session timeline by session id, including timing, waits, tools, subagents, queue activity, configured remote sessions, drag-to-zoom, or clickable event/tool details.
---

# Codex Session Timeline

Use this skill to run the bundled local dashboard for Codex session timing.

## App Location

The dashboard app is bundled in this plugin at:

```text
<plugin root>/scripts/timeline-app
```

When resolving paths from this skill file, the app directory is:

```text
../../scripts/timeline-app
```

It is a dependency-free Node app. It uses Node's standard library plus the local `sqlite3` CLI.

## Start Or Reuse The Server

The dashboard binds to `127.0.0.1` by default and should stay local-only unless the user explicitly asks for another exposure model.

Default port:

```text
8787
```

Before starting a new server, check whether `127.0.0.1:8787` is already serving the dashboard. If it is, reuse it.

To start it:

```bash
npm start
```

Run that command from:

```text
<plugin root>/scripts/timeline-app
```

If port `8787` is occupied by something else, choose another local port and start with:

```bash
PORT=<free-port> npm start
```

## Open A Session

For a local Codex session id:

```text
http://127.0.0.1:<port>/?session=<session-id>
```

For a local session written under a non-default `CODEX_HOME`, such as a scripted API-key CLI run:

```text
http://127.0.0.1:<port>/?session=<session-id>&codex_home=<url-encoded-codex-home>
```

For a configured SSH remote alias:

```text
http://127.0.0.1:<port>/?session=<session-id>&remote=<alias>
```

Remote aliases can be configured at server start with:

```bash
CODEX_TIMELINE_REMOTE_HOSTS=workstation=devbox.example.com,lab=lab-host npm start
```

## What The Dashboard Shows

- Parent session timing and explicit wait/tool spans.
- Spawned subagent sessions and their visible tool/wait activity.
- Queue Service queues and queue item lifetimes.
- Drag-to-zoom timeline selection.
- Clickable event dots for prompts, assistant messages, goals, compactions, and aborts.
- Clickable wait/tool bars with tool name, duration, arguments, wait target, queue conditions, and output summary.

## Browser Validation

When the Browser plugin is available and the user asks to open or test the page, use the in-app Browser for the localhost URL. After changing dashboard code, reload the page and verify:

- The title is `Codex Session Timeline`.
- The timeline SVG is present.
- There are no relevant console errors or warnings.
- At least one dot and one wait/tool bar opens a detail popover.

## Data Sources

Local mode reads:

- `~/.codex/session_index.jsonl`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.jsonl`
- `~/.cache/codex-queue-service/queues.sqlite`

Override paths with:

```bash
CODEX_HOME=/path/to/.codex QUEUE_SERVICE_DB=/path/to/queues.sqlite npm start
```

Remote mode reads session JSONL over SSH and copies the remote Queue Service SQLite DB into:

```text
~/.cache/codex-session-timeline/remote/<alias>/queues.sqlite
```
