# Codex Session Timeline

Local dashboard for visualizing a Codex session id: parent timing, wait-heavy tool calls, spawned subagents, Queue Service rows, and queue item lifetimes.

## Interface Highlights

- Sticky session command bar with refresh, export, and active time-window readout.
- Main timeline with event/tool/wait/spawn filters, drag-to-zoom, and a resizable minimap brush.
- Nested agent-job and app-worker lanes with compact descriptive labels.
- Queue workload view with compact queue names, zoom/pan/reset controls, drag-to-zoom, and clickable aggregate heatmap buckets.
- Right-side detail inspector for selected events, spans, lanes, queue rows, and queue workload buckets.

## Run

```bash
npm start
```

Then open:

```text
http://127.0.0.1:8787/?session=019e994f-92eb-7e11-862f-3c2b76a74757
```

No npm dependencies are required. The server uses Node's standard library and the local `sqlite3` CLI.

For a session that lives on a configured SSH remote, add `remote=<alias>`:

```text
http://127.0.0.1:8787/?session=019ea23a-7f8f-7e70-983e-1678e667520a&remote=workstation
```

## Data Sources

- `~/.codex/session_index.jsonl` for session titles and recent sessions.
- `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions/*.jsonl` for parent and subagent transcripts.
- `~/.cache/codex-queue-service/queues.sqlite` for Queue Service namespaces, queues, and items.

Override paths when needed:

```bash
CODEX_HOME=/path/to/.codex QUEUE_SERVICE_DB=/path/to/queues.sqlite PORT=8787 npm start
```

Remote aliases can be extended with comma-separated `name=ssh-host` entries:

```bash
CODEX_TIMELINE_REMOTE_HOSTS=workstation=devbox.example.com,lab=lab-host npm start
```

Remote mode reads Codex JSONL files over SSH and copies the remote Queue Service SQLite DB into `~/.cache/codex-session-timeline/remote/<alias>/queues.sqlite` before querying it locally.

## Timing Notes

The dashboard uses exact transcript timestamps for tool calls, explicit wait calls, spawn calls, messages, compaction, and goal updates. Queue item timing comes from Queue Service rows: created, updated, lease expiry, and completed timestamps.

Subagent "quiet" time means the child session was alive but had no in-flight tool span recorded. That can include model reasoning, UI latency, or true idle time; it is best read as "not directly visible as a tool or explicit wait."

## Local Checks

```bash
node --check server.js
node --check public/app.js
node scripts/verify-render.js "http://127.0.0.1:8787/?session=<session-id>"
node scripts/verify-interactions.js "http://127.0.0.1:8787/?session=<session-id>"
```
