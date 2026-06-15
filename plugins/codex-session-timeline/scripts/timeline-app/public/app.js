"use strict";

const form = document.getElementById("session-form");
const sessionPicker = document.getElementById("session-picker");
const input = document.getElementById("session-id");
const sessionPickerToggle = document.getElementById("session-picker-toggle");
const sessionPickerMenu = document.getElementById("session-picker-menu");
const commandSessionId = document.getElementById("command-session-id");
const commandWindowStart = document.getElementById("command-window-start");
const commandWindowEnd = document.getElementById("command-window-end");
const commandWindowDuration = document.getElementById("command-window-duration");
const refreshSessionButton = document.getElementById("refresh-session");
const exportSessionButton = document.getElementById("export-session");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const viewTabs = document.getElementById("view-tabs");
const timelineTab = document.getElementById("timeline-tab");
const queuesTab = document.getElementById("queues-tab");
const queueTabCount = document.getElementById("queue-tab-count");
const filterEvents = document.getElementById("filter-events");
const filterTools = document.getElementById("filter-tools");
const filterWaits = document.getElementById("filter-waits");
const filterSpawns = document.getElementById("filter-spawns");
const queueProgressCard = document.getElementById("queue-progress-card");
const queueProgress = document.getElementById("queue-progress");
const queueRefreshButton = document.getElementById("queue-refresh");
const queueAutoRefresh = document.getElementById("queue-auto-refresh");
const queueRefreshStatus = document.getElementById("queue-refresh-status");
const timelineCard = document.getElementById("timeline-card");
const timelineWrap = document.getElementById("timeline-wrap");
const timelineMinimap = document.getElementById("timeline-minimap");
const timelineCaption = document.getElementById("timeline-caption");
const queueTimelineCard = document.getElementById("queue-timeline-card");
const queueTimelineWrap = document.getElementById("queue-timeline-wrap");
const queueTimelineCaption = document.getElementById("queue-timeline-caption");
const queueTimelineReadout = document.getElementById("queue-timeline-readout");
const queueTimelineZoomIn = document.getElementById("queue-timeline-zoom-in");
const queueTimelineZoomOut = document.getElementById("queue-timeline-zoom-out");
const queueTimelinePanLeft = document.getElementById("queue-timeline-pan-left");
const queueTimelinePanRight = document.getElementById("queue-timeline-pan-right");
const queueTimelineReset = document.getElementById("queue-timeline-reset");
const timelineReadout = document.getElementById("timeline-readout");
const timelineZoomIn = document.getElementById("timeline-zoom-in");
const timelineZoomOut = document.getElementById("timeline-zoom-out");
const timelinePanLeft = document.getElementById("timeline-pan-left");
const timelinePanRight = document.getElementById("timeline-pan-right");
const timelineReset = document.getElementById("timeline-reset");
const timelineNow = document.getElementById("timeline-now");
const followActive = document.getElementById("follow-active");
const subagentsPanel = document.getElementById("subagents");
const subagentTable = document.getElementById("subagent-table");
const queuesPanel = document.getElementById("queues");
const queueTable = document.getElementById("queue-table");
const warningsEl = document.getElementById("warnings");
const markerPopover = document.getElementById("marker-popover");
const markerPopoverCard = document.getElementById("marker-popover-card");
const inspectorEmpty = document.getElementById("inspector-empty");
const markerPopoverKicker = document.getElementById("marker-popover-kicker");
const markerPopoverTitle = document.getElementById("marker-popover-title");
const markerPopoverMeta = document.getElementById("marker-popover-meta");
const markerPopoverBody = document.getElementById("marker-popover-body");
const markerPopoverClose = document.getElementById("marker-popover-close");

let currentData = null;
let activeView = "timeline";
let queueRefreshTimer = null;
let queueRefreshInFlight = false;
let queueLastRefreshed = null;
let timelineView = null;
let timelineDrag = null;
let minimapDrag = null;
let queueTimelineView = null;
let queueTimelineDrag = null;
let markerLookup = new Map();
let spanLookup = new Map();
let laneLookup = new Map();
let queueItemLookup = new Map();
let queueActivityLookup = new Map();
let queueLaneLookup = new Map();
let sessionSuggestions = [];
let highlightedSessionSuggestion = -1;
let sessionSuggestionTimer = null;
let sessionSuggestionRequest = 0;

const MIN_TIMELINE_WINDOW_MS = 30 * 1000;
const DRAG_ZOOM_MIN_PX = 8;
const MINIMAP_DRAG_MIN_PX = 6;
const MINIMAP_HANDLE_HIT_PX = 14;

function timelineFilters() {
  return {
    events: filterEvents?.checked !== false,
    tools: filterTools?.checked !== false,
    waits: filterWaits?.checked !== false,
    spawns: filterSpawns?.checked !== false,
  };
}

function spanVisualType(span) {
  if (!span || typeof span === "string") return span || "tool";
  const type = span.type || "tool";
  const name = String(span.name || span.label || "");
  if (type === "spawn" || name === "spawn_agent" || name === "spawn_agents_on_csv") return "spawn";
  return type;
}

function shouldShowSpan(span) {
  const filters = timelineFilters();
  const type = spanVisualType(span);
  if (type === "wait") return filters.waits;
  if (type === "spawn") return filters.spawns;
  return filters.tools;
}

function shouldShowMarker() {
  return timelineFilters().events;
}

function updateCommandChrome(data) {
  const session = data?.session;
  const domain = data?.domain;
  const title = session?.title || "Untitled session";
  const id = session?.id || "Waiting for session";
  const duration = domain ? fmtDuration(domain.end - domain.start) : "0ms";

  if (commandSessionId) commandSessionId.textContent = id;
  if (commandWindowStart) commandWindowStart.textContent = domain ? fmtTime(domain.start) : "--:--:--";
  if (commandWindowEnd) commandWindowEnd.textContent = domain ? fmtTime(domain.end) : "--:--:--";
  if (commandWindowDuration) commandWindowDuration.textContent = duration;
}

function setSessionRefreshBusy(busy) {
  if (!refreshSessionButton) return;
  refreshSessionButton.disabled = busy;
  refreshSessionButton.textContent = busy ? "Refreshing..." : "Refresh";
}

function exportCurrentSession() {
  if (!currentData) return;
  const payload = JSON.stringify(currentData, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `codex-session-${currentData.session.id}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  const totalMs = Math.round(ms);
  if (totalMs < 1000) return `${totalMs}ms`;
  const sec = Math.floor(totalMs / 1000);
  const remMs = totalMs % 1000;
  if (sec < 10) return remMs ? `${sec}s ${remMs}ms` : `${sec}s`;
  if (sec < 90) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 90) return remSec ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

function fmtCount(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtDateTime(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtAxisTime(ms, spanMs) {
  if (!Number.isFinite(ms)) return "";
  if (spanMs > 48 * 60 * 60 * 1000) {
    return new Date(ms).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
    }).replace(",", "");
  }
  return fmtTime(ms);
}

function pct(part, total) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function metric(label, value, hint) {
  return `
    <div class="metric">
      <div class="label">${esc(label)}</div>
      <div class="value">${esc(value)}</div>
      <div class="hint" title="${esc(hint || "")}">${esc(hint || "")}</div>
    </div>
  `;
}

function updateStatus(message, kind = "muted") {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = message;
}

function isInternalApprovalReviewer(session) {
  return subagentSourceKind(session) === "guardian";
}

function subagentSourceKind(session) {
  const other = session?.meta?.source?.subagent?.other;
  return typeof other === "string" ? other : "";
}

function isAgentJobSession(session) {
  return subagentSourceKind(session).startsWith("agent_job:");
}

function isAppThreadSession(session) {
  return session?.meta?.threadSource === "app_server" || Boolean(session?.meta?.source?.app_server);
}

function isQueueWorkerSession(session) {
  return session?.meta?.threadSource === "queue_worker" || Boolean(session?.meta?.source?.queue_worker);
}

function agentJobId(session) {
  const kind = subagentSourceKind(session);
  return kind.startsWith("agent_job:") ? kind.slice("agent_job:".length) : "";
}

const LEADING_UUID_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i;

function compactWorkerName(value) {
  const text = String(value || "").trim();
  const match = text.match(LEADING_UUID_PREFIX_RE);
  return match ? match[1] : text;
}

function childSessionDisplay(session) {
  if (isQueueWorkerSession(session)) {
    const source = session.meta?.source?.queue_worker || {};
    const name = source.worker_id || session.meta?.agentNickname || session.title || session.id.slice(0, 13);
    return {
      lanePrefix: "queue worker",
      name,
      tableName: "queue worker",
      tableClass: "pill pill-queue-worker",
      sessionLabel: `${name} (${(source.queues || []).join(", ") || "queue"})`,
    };
  }

  if (isAppThreadSession(session)) {
    const source = session.meta?.source?.app_server || {};
    const rawName = source.worker_id || session.meta?.agentNickname || session.title || session.id.slice(0, 13);
    const name = source.worker_id ? compactWorkerName(rawName) : rawName;
    const lanePrefix = source.worker_id ? "app worker" : "app thread";
    return {
      lanePrefix,
      name,
      tableName: lanePrefix,
      tableClass: "pill pill-app-thread",
      sessionLabel: `${name} (${session.id})`,
    };
  }

  if (isInternalApprovalReviewer(session)) {
    return {
      lanePrefix: "approval reviewer",
      name: session.id.slice(0, 8),
      tableName: "approval reviewer",
      tableClass: "pill pill-internal",
      sessionLabel: `guardian approval reviewer (${session.id})`,
    };
  }

  if (isAgentJobSession(session)) {
    return {
      lanePrefix: "agent_job",
      name: session.id.slice(0, 13),
      tableName: "agent_job",
      tableClass: "pill pill-agent-job",
      sessionLabel: session.id,
    };
  }

  const name = session.meta.agentNickname || session.title || session.id.slice(0, 8);
  return {
    lanePrefix: "agent",
    name,
    tableName: name,
    tableClass: "pill",
    sessionLabel: session.title || session.id,
  };
}

function clipText(text, max = 900) {
  const value = String(text || "").trim();
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function firstMarkerDetail(session, type) {
  return (session.markers || []).find((marker) => marker.type === type)?.detail || "";
}

function promptField(prompt, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(prompt || "").match(new RegExp(`^${escaped}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : "";
}

function promptBlock(prompt, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(prompt || "").match(new RegExp(`^${escaped}:\\s*\\n([\\s\\S]+?)(?:\\n\\n[A-Z][A-Za-z ]+:|$)`, "m"));
  return match ? match[1].trim() : "";
}

function agentJobTaskSummary(session) {
  const prompt = firstMarkerDetail(session, "user");
  const itemId = promptField(prompt, "Item ID");
  const job = promptField(prompt, "Job ID") || agentJobId(session);
  const instruction = promptBlock(prompt, "Task instruction") || prompt;
  const lines = [];

  if (itemId) lines.push(`Item ID: ${itemId}`);
  if (job) lines.push(`Job ID: ${job}`);
  if (instruction) lines.push(`Task instruction: ${clipText(instruction, 700)}`);
  if (!lines.length) lines.push("Task instruction: No user prompt was captured for this child session.");

  return lines.join("\n");
}

function appThreadTaskSummary(session) {
  const source = session.meta?.source?.app_server || {};
  const lines = [];

  if (source.worker_id) lines.push(`Worker ID: ${source.worker_id}`);
  if (source.job_id) lines.push(`Job ID: ${source.job_id}`);
  if (source.created_via) lines.push(`Created via: ${source.created_via}`);
  if (source.launcher_status) lines.push(`Launcher status: ${source.launcher_status}`);
  if (source.missing_done_marker) lines.push("Completion marker: missing .codex-worker-launcher/done.json");
  if (source.app_server_pid) lines.push(`App-server PID: ${source.app_server_pid}`);
  if (source.launcher_pid) lines.push(`Launcher PID: ${source.launcher_pid}`);
  if (source.thread_status) lines.push(`Last app-server status: ${source.thread_status}`);
  if (source.read_snapshots != null) lines.push(`read_thread snapshots captured: ${source.read_snapshots}`);
  if (source.archived) lines.push("Archived via app-server: yes");
  if (source.project_id) lines.push(`Project: ${source.project_id}`);
  if (source.prompt_file) lines.push(`Prompt file: ${source.prompt_file}`);
  if (source.worker_config) lines.push(`Worker config: ${source.worker_config}`);
  if (source.ready_file) lines.push(`Ready file: ${source.ready_file}`);
  if (source.status_file) lines.push(`Status file: ${source.status_file}`);
  if (source.events_file) lines.push(`Events file: ${source.events_file}`);
  if (source.done_file) lines.push(`Done file: ${source.done_file}`);
  if (source.event_rows != null) {
    lines.push(`Launcher event rows parsed: ${source.event_rows}${source.event_rows_truncated ? " (truncated)" : ""}`);
  }
  if (source.prompt) {
    const promptLabel = String(source.created_via || "").includes("launcher")
      ? "Worker prompt"
      : "Original create_thread prompt";
    lines.push(`${promptLabel}: ${clipText(source.prompt, 1000)}`);
  }
  if (!lines.length) lines.push("No app-server create_thread context was captured for this thread.");

  return lines.join("\n");
}

function queueWorkerTaskSummary(session) {
  const source = session.meta?.source?.queue_worker || {};
  const counts = source.counts || {};
  const queues = source.queues || [];
  const samples = source.item_samples || [];
  const sampleLines = samples
    .map((item, index) => {
      const lines = [
        `Sample ${index + 1}: ${item.queueName || "queue"} / ${item.label || item.id}`,
        `Status: ${item.status || "unknown"}`,
        item.created ? `Queued: ${fmtDateTime(item.created)}` : "",
        item.completed ? `Completed: ${fmtDateTime(item.completed)}` : "",
        item.latencyMs ? `Queue latency: ${fmtDuration(item.latencyMs)}` : "",
        item.payloadPreview ? `Payload:\n${item.payloadPreview}` : "",
        item.resultPreview ? `Result:\n${item.resultPreview}` : "",
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
  return [
    "Kind: inferred Queue Service worker, not a Codex child session.",
    source.worker_id ? `Worker ID: ${source.worker_id}` : "",
    queues.length ? `Queues: ${queues.join(", ")}` : "",
    source.namespace ? `Namespace: ${source.namespace}` : "",
    source.first_item_created ? `First item queued: ${fmtDateTime(source.first_item_created)}` : "",
    source.first_observed_activity ? `First observed worker activity: ${fmtDateTime(source.first_observed_activity)}` : "",
    source.last_observed_activity ? `Last observed worker activity: ${fmtDateTime(source.last_observed_activity)}` : "",
    `Items observed: ${counts.total || 0}`,
    `Completed: ${counts.completed || 0}`,
    `Leased now: ${counts.leased || 0}`,
    `Queued with worker ID: ${counts.queued || 0}`,
    `Failed: ${counts.failed || 0}`,
    source.queue_instructions ? `What it was sent:\n${source.queue_instructions}` : "",
    sampleLines ? `Item samples:\n${sampleLines}` : "",
    source.transcript_status ? `Transcript:\n${source.transcript_status}` : "",
    "Tools:\nNo per-worker tool calls are available because this logical worker did not run as a separate Codex session. Its work happened inside the parent thread/tool process that touched the queue.",
    source.timing_source
      ? `Timing source: ${source.timing_source}`
      : "Timing source: Queue Service item records.",
  ]
    .filter(Boolean)
    .join("\n");
}

function sessionTaskSummary(session) {
  if (isQueueWorkerSession(session)) return queueWorkerTaskSummary(session);
  if (isAppThreadSession(session)) return appThreadTaskSummary(session);
  return agentJobTaskSummary(session);
}

function sessionTimingSummary(session) {
  if (isQueueWorkerSession(session)) {
    const source = session.meta?.source?.queue_worker || {};
    const counts = source.counts || {};
    return [
      `Observed activity span: ${fmtDuration(session.elapsedMs || 0)}`,
      `Item events: ${session.metrics?.eventCount || 0}`,
      `Active lease spans: ${session.metrics?.spanCount || 0}`,
      `Completed items: ${counts.completed || 0}`,
      `Failed items: ${counts.failed || 0}`,
      `Worker start note: Queue Service does not record a separate worker creation event here; first observed activity is the first retained lease/completion signal.`,
      `Transcript note: completed queue items do not keep lease_owner; this view uses result.worker_id when present.`,
    ].join("\n");
  }

  const elapsed = session.elapsedMs || 0;
  const tool = session.metrics?.toolMs || 0;
  const wait = session.metrics?.waitMs || 0;
  const quiet = session.metrics?.quietMs || 0;
  const busy = session.metrics?.busyMs || tool + wait;

  return [
    `Live span: ${fmtDuration(elapsed)}`,
    `Tool time: ${fmtDuration(tool)} (${pct(tool, elapsed)})`,
    `Explicit wait: ${fmtDuration(wait)} (${pct(wait, elapsed)})`,
    `Quiet/idle: ${fmtDuration(quiet)} (${pct(quiet, elapsed)})`,
    `Measured busy time: ${fmtDuration(busy)} (${pct(busy, elapsed)})`,
    `Captured spans: ${session.metrics?.spanCount || 0}`,
    `Transcript events: ${session.metrics?.eventCount || 0}`,
  ].join("\n");
}

function mainSessionRows(data) {
  return [
    data.session,
    ...(data.subagents || []),
    ...(data.appThreads || []),
  ];
}

function timelineChildRows(data) {
  const children = data.subagents || [];
  const byParent = new Map();
  const emitted = new Set();
  for (const child of children) {
    const parentId = child.parentSessionId || data.session.id;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(child);
  }
  for (const group of byParent.values()) {
    group.sort((a, b) => (a.start || 0) - (b.start || 0));
  }

  const ordered = [];
  const visit = (parentId) => {
    for (const child of byParent.get(parentId) || []) {
      if (emitted.has(child.id)) continue;
      emitted.add(child.id);
      ordered.push(child);
      visit(child.id);
    }
  };
  visit(data.session.id);

  for (const child of children.slice().sort((a, b) => (a.start || 0) - (b.start || 0))) {
    if (emitted.has(child.id)) continue;
    emitted.add(child.id);
    ordered.push(child);
  }
  return ordered;
}

function timelineSessionRows(data) {
  return [
    data.session,
    ...timelineChildRows(data),
    ...(data.appThreads || []),
  ];
}

function activeSpansForSession(session) {
  return (session.spans || [])
    .filter((span) => span.active || span.status === "running")
    .map((span) => ({ ...span, session }));
}

function activeSpansForData(data) {
  return mainSessionRows(data).flatMap(activeSpansForSession).sort((a, b) => a.start - b.start);
}

function sessionDisplayName(session, parentId) {
  if (session.id === parentId) return "parent";
  const display = childSessionDisplay(session);
  return `${display.lanePrefix}: ${display.name}`;
}

function currentActivityMetric(data) {
  const active = activeSpansForData(data);
  if (!active.length) return null;

  const newest = active[active.length - 1];
  const owner = sessionDisplayName(newest.session, data.session.id);
  const others = active.length > 1 ? `; ${active.length - 1} other active call${active.length === 2 ? "" : "s"}` : "";
  const visualType = spanVisualType(newest);
  const activityKind =
    visualType === "wait" ? "wait" : visualType === "spawn" ? "spawn" : "tool";
  return metric(
    "Current activity",
    `running ${activityKind}`,
    `${owner}: ${newest.label || newest.name || activityKind} for ${fmtDuration(newest.durationMs)}; waiting for result${others}`,
  );
}

function openSessionPopover(session, target) {
  if (!session) return;
  const display = childSessionDisplay(session);
  const prompt = firstMarkerDetail(session, "user");
  const parentLine = session.parentSessionId
    ? `Spawned by: ${session.parentSessionLabel || session.parentSessionId} (${session.parentSessionId})`
    : "";
  const sections = [
    "Task",
    sessionTaskSummary(session),
    "",
    "Timing",
    sessionTimingSummary(session),
    "",
    "Session",
    [
      `ID: ${session.id}`,
      session.start ? `Started: ${fmtDateTime(session.start)}` : "",
      session.end ? `Ended: ${fmtDateTime(session.end)}` : "",
      session.meta?.cwd ? `Working directory: ${session.meta.cwd}` : "",
      parentLine,
      subagentSourceKind(session) ? `Source: ${subagentSourceKind(session)}` : "",
      isAppThreadSession(session) ? "Source: codex_app app-server thread" : "",
      isQueueWorkerSession(session) ? "Source: Queue Service item records" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  ];

  if (prompt) {
    sections.push("", "Prompt excerpt", clipText(prompt, 1100));
  }

  openDetailPopover(
    {
      kicker: display.lanePrefix || "child session",
      title: `${display.lanePrefix}: ${display.name}`,
      meta: [
        fmtDateTime(session.start),
        `${fmtDuration(session.elapsedMs)} live`,
        `${fmtDuration(session.metrics?.toolMs || 0)} tools`,
        `${fmtDuration(session.metrics?.quietMs || 0)} quiet/idle`,
      ],
      body: sections.join("\n"),
    },
    target,
  );
}

function currentRemote() {
  return new URL(window.location.href).searchParams.get("remote") || "";
}

function currentCodexHome() {
  const params = new URL(window.location.href).searchParams;
  return params.get("codex_home") || params.get("codexHome") || "";
}

function apiQueryString() {
  const params = new URLSearchParams();
  const remote = currentRemote();
  const codexHome = currentCodexHome();
  if (remote) params.set("remote", remote);
  if (codexHome && !remote) params.set("codex_home", codexHome);
  return params.toString() ? `?${params.toString()}` : "";
}

function setQueueRefreshStatus(text, className = "") {
  if (!queueRefreshStatus) return;
  queueRefreshStatus.textContent = text;
  queueRefreshStatus.className = `queue-refresh-status ${className}`.trim();
}

function setQueueRefreshBusy(busy) {
  queueRefreshInFlight = busy;
  if (queueRefreshButton) queueRefreshButton.disabled = busy || !currentData;
}

function stopQueueAutoRefresh() {
  if (queueRefreshTimer) clearInterval(queueRefreshTimer);
  queueRefreshTimer = null;
}

function setQueueAutoRefresh(enabled) {
  stopQueueAutoRefresh();
  if (queueAutoRefresh) queueAutoRefresh.checked = Boolean(enabled);
  if (!enabled) {
    if (queueLastRefreshed) {
      setQueueRefreshStatus(`Updated ${fmtTime(queueLastRefreshed)} · auto refresh off`);
    }
    return;
  }
  setQueueRefreshStatus("Auto-refreshing every 10s");
  if (activeView === "queues" && currentData && !queueRefreshInFlight) {
    refreshQueuesOnly({ silent: true });
  }
  queueRefreshTimer = setInterval(() => {
    if (activeView !== "queues" || queueRefreshInFlight) return;
    refreshQueuesOnly({ silent: true });
  }, 10_000);
}

function sessionTitle(row) {
  return row?.thread_name || row?.title || "Untitled thread";
}

function sessionUpdated(row) {
  const ms = Date.parse(row?.updated_at || row?.updatedAt || "");
  return Number.isFinite(ms) ? fmtDateTime(ms) : "";
}

function shortSessionId(id) {
  const text = String(id || "");
  return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : text;
}

function sessionSearchUrl(query) {
  const params = new URLSearchParams({ limit: "80" });
  if (query) params.set("q", query);
  const remote = currentRemote();
  if (remote) params.set("remote", remote);
  const codexHome = currentCodexHome();
  if (codexHome && !remote) params.set("codex_home", codexHome);
  return `/api/sessions?${params.toString()}`;
}

function setSessionPickerOpen(open) {
  if (!sessionPickerMenu) return;
  sessionPickerMenu.hidden = !open;
  sessionPicker?.classList.toggle("is-open", open);
  input?.setAttribute("aria-expanded", String(open));
}

function setHighlightedSessionSuggestion(index) {
  highlightedSessionSuggestion = index;
  const options = sessionPickerMenu?.querySelectorAll("[data-session-index]") || [];
  options.forEach((option) => {
    const active = Number(option.dataset.sessionIndex) === index;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", String(active));
    if (active) input?.setAttribute("aria-activedescendant", option.id);
  });
  if (index < 0) input?.removeAttribute("aria-activedescendant");
}

function renderSessionSuggestions(rows, message = "") {
  if (!sessionPickerMenu) return;
  sessionSuggestions = rows || [];
  if (message) {
    sessionPickerMenu.innerHTML = `<div class="session-option session-option-empty">${esc(message)}</div>`;
    setHighlightedSessionSuggestion(-1);
    setSessionPickerOpen(true);
    return;
  }

  if (!sessionSuggestions.length) {
    sessionPickerMenu.innerHTML = `<div class="session-option session-option-empty">No matching threads</div>`;
    setHighlightedSessionSuggestion(-1);
    setSessionPickerOpen(true);
    return;
  }

  sessionPickerMenu.innerHTML = sessionSuggestions
    .map((row, index) => {
      const updated = sessionUpdated(row);
      return `
        <div
          id="session-option-${index}"
          class="session-option"
          role="option"
          aria-selected="false"
          data-session-index="${index}"
        >
          <div class="session-option-title">${esc(sessionTitle(row))}</div>
          <div class="session-option-meta">
            <span class="session-option-id">${esc(shortSessionId(row.id))}</span>
            ${updated ? `<span>${esc(updated)}</span>` : ""}
          </div>
        </div>
      `;
    })
    .join("");
  setSessionPickerOpen(true);
  setHighlightedSessionSuggestion(0);
}

async function fetchSessionSuggestions(query = "") {
  const requestId = ++sessionSuggestionRequest;
  renderSessionSuggestions([], "Loading threads...");
  try {
    const res = await fetch(sessionSearchUrl(query));
    const data = await res.json();
    if (requestId !== sessionSuggestionRequest) return;
    if (!res.ok || !data.ok) throw new Error(data.error || "Unable to list sessions.");
    renderSessionSuggestions(data.sessions || []);
  } catch (err) {
    if (requestId !== sessionSuggestionRequest) return;
    renderSessionSuggestions([], err.message || "Unable to list sessions.");
  }
}

function scheduleSessionSuggestionSearch() {
  clearTimeout(sessionSuggestionTimer);
  sessionSuggestionTimer = setTimeout(() => {
    fetchSessionSuggestions(input.value.trim());
  }, 180);
}

function closeSessionPicker() {
  clearTimeout(sessionSuggestionTimer);
  sessionSuggestionRequest += 1;
  setSessionPickerOpen(false);
  setHighlightedSessionSuggestion(-1);
}

async function submitSessionId(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return;
  closeSessionPicker();
  input.value = id;
  const url = new URL(window.location.href);
  url.searchParams.set("session", id);
  history.replaceState(null, "", url);
  try {
    await loadSession(id);
  } catch (err) {
    currentData = null;
    updateStatus(err.message, "");
  }
}

async function refreshCurrentSession() {
  const id = String(currentData?.session?.id || input?.value || "").trim();
  if (!id) return;
  setSessionRefreshBusy(true);
  try {
    await loadSession(id);
  } catch (err) {
    currentData = null;
    updateStatus(err.message || "Unable to refresh session.", "");
  } finally {
    setSessionRefreshBusy(false);
  }
}

function selectSessionSuggestion(index) {
  const row = sessionSuggestions[index];
  if (!row?.id) return;
  submitSessionId(row.id);
}

async function loadSession(sessionId) {
  const remote = currentRemote();
  const codexHome = currentCodexHome();
  timelineView = null;
  queueTimelineView = null;
  queueTimelineDrag = null;
  stopQueueAutoRefresh();
  if (queueAutoRefresh) queueAutoRefresh.checked = false;
  setQueueRefreshStatus("Not refreshed yet");
  closeMarkerPopover();
  updateStatus(`Loading ${sessionId}${remote ? ` from ${remote}` : codexHome ? " from custom CODEX_HOME" : ""}...`);
  summaryEl.hidden = true;
  viewTabs.hidden = true;
  queueProgressCard.hidden = true;
  timelineCard.hidden = true;
  queueTimelineCard.hidden = true;
  if (subagentsPanel) subagentsPanel.hidden = true;
  queuesPanel.hidden = true;
  warningsEl.hidden = true;

  const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}${apiQueryString()}`);
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data.error || "Unable to load session.");
  currentData = data;
  activeView = "timeline";
  render(data);
}

function render(data) {
  const session = data.session;
  const queue = data.queue;
  const appThreads = data.appThreads || [];
  const queueWorkers = data.queueWorkers || queue.workers || [];
  const childRows = [...(data.subagents || []), ...appThreads];
  const totalElapsed = data.domain.end - data.domain.start;
  const allWaitMs =
    session.metrics.waitMs +
    childRows.reduce((sum, child) => sum + child.metrics.waitMs, 0);
  const childElapsed = childRows.reduce((sum, child) => sum + child.elapsedMs, 0);
  const remoteLabel = data.source?.type === "remote" ? ` | remote: ${data.source.remote}` : "";
  const internalReviewers = data.subagents.filter(isInternalApprovalReviewer).length;
  const agentJobs = data.subagents.filter(isAgentJobSession).length;
  const namedAgents = data.subagents.length - internalReviewers - agentJobs;
  const appWorkers = appThreads.filter((thread) => thread.meta?.source?.app_server?.worker_id).length;
  const appOnlyThreads = appThreads.length - appWorkers;
  const queueWorkerCount = queueWorkers.length;
  const childSessionHint = [
    namedAgents ? `${namedAgents} named agent${namedAgents === 1 ? "" : "s"}` : "",
    agentJobs ? `${agentJobs} agent_job worker${agentJobs === 1 ? "" : "s"}` : "",
    appWorkers ? `${appWorkers} app-server worker${appWorkers === 1 ? "" : "s"}` : "",
    appOnlyThreads ? `${appOnlyThreads} app-server thread${appOnlyThreads === 1 ? "" : "s"}` : "",
    internalReviewers ? `${internalReviewers} internal approval reviewer${internalReviewers === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  updateStatus(
    `${session.title || "Untitled session"} | ${session.id}${remoteLabel} | ${fmtDateTime(data.domain.start)} to ${fmtDateTime(data.domain.end)}`,
  );
  updateCommandChrome(data);

  const currentActivity = currentActivityMetric(data);
  summaryEl.innerHTML = [
    metric("Total span", fmtDuration(totalElapsed), session.meta.cwd || session.filePath),
    metric("Parent wait", fmtDuration(session.metrics.waitMs), `${pct(session.metrics.waitMs, session.elapsedMs)} of parent session`),
    metric("All explicit wait", fmtDuration(allWaitMs), "queue_wait_for_event and wait-like tools"),
    currentActivity,
    metric(
      "Child activity",
      String(childRows.length),
      childSessionHint || `${fmtDuration(childElapsed)} summed live span`,
    ),
    metric(
      "Queue items",
      String(queue.stats.total || 0),
      [
        `${queue.stats.completed || 0} done`,
        `${queue.stats.leased || 0} leased`,
        `${queue.stats.queued || 0} queued`,
        queueWorkerCount ? `${queueWorkerCount} queue workers` : "",
      ]
        .filter(Boolean)
        .join(", "),
    ),
    metric("Avg queue latency", fmtDuration(queue.stats.avgCompletedLatencyMs || 0), `${queue.stats.completedLatencyCount || 0} completed items`),
  ].filter(Boolean).join("");
  summaryEl.hidden = false;
  renderQueueProgress(queue);
  queueLastRefreshed = Date.now();
  setQueueRefreshStatus(`Loaded ${fmtTime(queueLastRefreshed)} · ${fmtCount(queue.stats?.total || queue.itemRowsTotal || 0)} items`);
  setQueueRefreshBusy(false);
  viewTabs.hidden = false;

  timelineCaption.textContent =
    queue.stats.total || queue.timeline?.length || childRows.length
      ? "Parent thread, child sessions, and app-server workers share the same time scale. Queue item processing is separated into the Queues tab so large queues do not slow this graph down."
      : "Parent thread events only. Click bars or dots for details.";
  renderTimeline(data);
  if (followActive?.checked) focusActiveSpan();
  updateTimelineControls(data);
  timelineCard.hidden = false;

  renderQueues(queue);
  applyActiveView();

  if (data.warnings && data.warnings.length) {
    warningsEl.innerHTML = `<strong>Notes</strong><br>${data.warnings.map(esc).join("<br>")}`;
    warningsEl.hidden = false;
  }
}

function hasQueueData(queue) {
  return Boolean((queue?.stats?.total || 0) || (queue?.queues || []).length || (queue?.itemRowsTotal || 0));
}

function setActiveView(view) {
  activeView = view === "queues" ? "queues" : "timeline";
  if (activeView === "queues" && currentData) renderQueueTimeline(currentData);
  applyActiveView();
}

function applyActiveView() {
  if (!currentData) return;
  const queue = currentData.queue || {};
  const showQueues = activeView === "queues";
  timelineTab?.classList.toggle("is-active", !showQueues);
  queuesTab?.classList.toggle("is-active", showQueues);
  timelineTab?.setAttribute("aria-selected", String(!showQueues));
  queuesTab?.setAttribute("aria-selected", String(showQueues));
  timelineCard.hidden = showQueues;
  queueProgressCard.hidden = !showQueues;
  queueTimelineCard.hidden = !showQueues || !hasQueueData(queue) || !(queue.timeline || []).length;
  const childCount =
    (currentData.subagents || []).length +
    (currentData.appThreads || []).length;
  if (subagentsPanel) subagentsPanel.hidden = true;
  queuesPanel.hidden = !showQueues || !hasQueueData(queue);
}

function queueCount(queue, status) {
  return Number(queue?.stats?.[status] || 0);
}

function progressPct(count, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (Number(count || 0) / total) * 100));
}

function progressSegment(status, count, total) {
  const width = progressPct(count, total);
  if (!width) return "";
  return `<span class="queue-progress-segment ${spanClass(status)}" style="width:${width.toFixed(3)}%" title="${esc(`${status}: ${fmtCount(count)}`)}"></span>`;
}

function queueProgressBar(counts) {
  const total = Math.max(0, Number(counts?.total || 0));
  if (!total) return `<div class="queue-progress-bar is-empty" title="No queue items"></div>`;
  return `
    <div class="queue-progress-bar" title="${esc(`${fmtCount(total)} item${total === 1 ? "" : "s"}`)}">
      ${progressSegment("completed", counts.completed || 0, total)}
      ${progressSegment("leased", counts.leased || 0, total)}
      ${progressSegment("queued", counts.queued || 0, total)}
      ${progressSegment("failed", counts.failed || 0, total)}
      ${progressSegment("failed", counts.cancelled || 0, total)}
    </div>
  `;
}

function queueProgressSummaryCard(label, value, hint, className = "") {
  return `
    <div class="queue-stat ${className}">
      <div class="queue-stat-label">${esc(label)}</div>
      <div class="queue-stat-value">${esc(value)}</div>
      <div class="queue-stat-hint">${esc(hint || "")}</div>
    </div>
  `;
}

function queueNameForDisplay(value) {
  return compactWorkerName(value || "");
}

function queueDisplayName(queue) {
  const name = queueNameForDisplay(queue?.name || "");
  return name.length > 78 ? `${name.slice(0, 34)}...${name.slice(-34)}` : name;
}

function queueProgressRow(queue) {
  const counts = queue.counts || {};
  const total = Number(counts.total || 0);
  const active = Number(counts.queued || 0) + Number(counts.leased || 0);
  const completed = Number(counts.completed || 0);
  const donePct = total ? Math.round((completed / total) * 100) : 0;
  const meta = [
    queue.status ? `job ${queue.status}` : "",
    queue.source === "codex-security" ? "Codex Security DB" : "Queue Service",
    queue.workerCount ? `${fmtCount(queue.workerCount)} worker${queue.workerCount === 1 ? "" : "s"}` : "",
    queue.sampleRowsLoaded != null ? `${fmtCount(queue.sampleRowsLoaded)} samples loaded` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <article class="queue-row">
      <div class="queue-row-main">
        <div>
          <h3 title="${esc(queue.name || "")}">${esc(queueDisplayName(queue))}</h3>
          <p class="muted" title="${esc(queue.namespace || "")}">${esc(meta || shortNamespace(queue.namespace || ""))}</p>
        </div>
        <div class="queue-row-percent">${donePct}% done</div>
      </div>
      ${queueProgressBar(counts)}
      <div class="queue-count-grid">
        <span><b>${fmtCount(counts.queued || 0)}</b> queued</span>
        <span><b>${fmtCount(counts.leased || 0)}</b> leased</span>
        <span><b>${fmtCount(counts.completed || 0)}</b> done</span>
        <span><b>${fmtCount(counts.failed || 0)}</b> failed</span>
        ${counts.cancelled ? `<span><b>${fmtCount(counts.cancelled)}</b> cancelled</span>` : ""}
        <span><b>${fmtCount(total)}</b> total</span>
        ${active ? `<span><b>${fmtDuration(Date.now() - (Date.parse(queue.updatedAt || queue.lastActivityAt || new Date()) || Date.now()))}</b> since update</span>` : ""}
      </div>
    </article>
  `;
}

function renderQueueProgress(queue) {
  if (!queueProgress) return;
  const stats = queue?.stats || {};
  const total = Number(queue?.itemRowsTotal || stats.total || 0);
  const queues = (queue?.queues || [])
    .slice()
    .sort((a, b) => {
      const aActive = Number(a.counts?.queued || 0) + Number(a.counts?.leased || 0);
      const bActive = Number(b.counts?.queued || 0) + Number(b.counts?.leased || 0);
      if (aActive !== bActive) return bActive - aActive;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  if (queueTabCount) queueTabCount.textContent = fmtCount(total || queues.length);

  const dbPaths = queue?.dbPaths || (queue?.dbPath ? [queue.dbPath] : []);
  if (!hasQueueData(queue)) {
    queueProgress.innerHTML = `
      <div class="queue-empty">
        <h3>No queue rows discovered for this session</h3>
        <p class="muted">I checked the session-linked Queue Service namespaces and app-server worker configs. No queue item rows were found in the loaded DBs.</p>
        ${dbPaths.length ? `<p class="muted db-paths" title="${esc(dbPaths.join("\n"))}">DB checked: ${esc(dbPaths.join(", "))}</p>` : ""}
      </div>
    `;
    return;
  }

  const active = Number(stats.queued || 0) + Number(stats.leased || 0);
  queueProgress.innerHTML = `
    <div class="queue-progress-summary">
      ${queueProgressSummaryCard("Total", fmtCount(total || stats.total || 0), `${fmtCount(queues.length)} queue/job row${queues.length === 1 ? "" : "s"}`)}
      ${queueProgressSummaryCard("Queued", fmtCount(stats.queued || 0), "waiting for workers", "queued")}
      ${queueProgressSummaryCard("Leased", fmtCount(stats.leased || 0), "currently checked out", "leased")}
      ${queueProgressSummaryCard("Done", fmtCount(stats.completed || 0), `${progressPct(stats.completed || 0, stats.total || total).toFixed(0)}% complete`, "completed")}
      ${queueProgressSummaryCard("Failed", fmtCount(stats.failed || 0), stats.cancelled ? `${fmtCount(stats.cancelled)} cancelled` : "failed items", "failed")}
      ${queueProgressSummaryCard("Active", fmtCount(active), "queued + leased")}
    </div>
    <div class="queue-progress-overall">
      ${queueProgressBar({
        total: stats.total || total,
        completed: stats.completed || 0,
        leased: stats.leased || 0,
        queued: stats.queued || 0,
        failed: stats.failed || 0,
        cancelled: stats.cancelled || 0,
      })}
    </div>
    <div class="queue-list">
      ${queues.map(queueProgressRow).join("")}
    </div>
    <p class="muted queue-footnote" title="${esc(dbPaths.join("\n"))}">
      ${fmtCount(queue.itemRowsLoaded || 0)} sampled item row${(queue.itemRowsLoaded || 0) === 1 ? "" : "s"} loaded from ${fmtCount(dbPaths.length)} DB${dbPaths.length === 1 ? "" : "s"}.
      ${queue.truncated ? "Details are sample-capped; totals come from SQL counts." : "Totals and samples are fully loaded for the discovered queue rows."}
    </p>
  `;
}

function updateQueuePanels(queue) {
  if (!currentData) return;
  currentData.queue = queue || {};
  currentData.queueWorkers = currentData.queue.workers || [];
  renderQueueProgress(currentData.queue);
  renderQueues(currentData.queue);
  if (activeView === "queues") renderQueueTimeline(currentData);
  applyActiveView();
}

async function refreshQueuesOnly(options = {}) {
  if (!currentData?.session?.id || queueRefreshInFlight) return;
  const silent = Boolean(options.silent);
  setQueueRefreshBusy(true);
  if (!silent) setQueueRefreshStatus("Refreshing...");
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(currentData.session.id)}/queue${apiQueryString()}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Unable to refresh queues.");
    updateQueuePanels(data.queue || {});
    queueLastRefreshed = Date.now();
    const itemTotal = data.queue?.stats?.total || data.queue?.itemRowsTotal || 0;
    setQueueRefreshStatus(`Updated ${fmtTime(queueLastRefreshed)} · ${fmtCount(itemTotal)} items`, "is-ok");
  } catch (err) {
    setQueueRefreshStatus(err.message || "Queue refresh failed", "is-error");
  } finally {
    setQueueRefreshBusy(false);
  }
}

function spanClass(typeOrStatus) {
  if (typeOrStatus === "wait") return "span-wait";
  if (typeOrStatus === "spawn") return "span-spawn";
  if (typeOrStatus === "queued") return "span-queued";
  if (typeOrStatus === "leased") return "span-leased";
  if (typeOrStatus === "completed") return "span-completed";
  if (typeOrStatus === "failed") return "span-failed";
  return "span-tool";
}

function markerColor(type) {
  if (type === "user") return "#151922";
  if (type === "task") return "#7257d4";
  if (type === "abort") return "#bf3f3f";
  if (type === "goal") return "#2e8b57";
  if (type === "compact") return "#8b95a7";
  if (type === "app") return "#0f8b8d";
  if (type === "queue_completed") return "#238357";
  if (type === "queue_leased") return "#087f9f";
  if (type === "queue_failed") return "#c13d3d";
  if (type === "queue_item") return "#8792a6";
  return "#3867d6";
}

function markerKindLabel(type) {
  if (type === "user") return "User prompt";
  if (type === "assistant") return "Assistant message";
  if (type === "task") return "Task started";
  if (type === "goal") return "Goal update";
  if (type === "compact") return "Context compaction";
  if (type === "abort") return "Turn aborted";
  if (type === "app") return "App-server thread event";
  if (type === "queue_completed") return "Queue worker completed item";
  if (type === "queue_leased") return "Queue worker leased item";
  if (type === "queue_failed") return "Queue worker failed item";
  if (type === "queue_item") return "Queue worker item event";
  return "Timeline event";
}

function markerPaintRank(type) {
  if (type === "task") return 10;
  if (type === "assistant") return 20;
  if (String(type || "").startsWith("queue_")) return 30;
  if (type === "goal") return 40;
  if (type === "abort") return 50;
  if (type === "user") return 60;
  if (type === "compact") return 70;
  if (type === "app") return 80;
  return 0;
}

function closeMarkerPopover() {
  if (!markerPopoverCard) return;
  markerPopoverCard.hidden = true;
  if (inspectorEmpty) inspectorEmpty.hidden = false;
}

function openDetailPopover(detail, target) {
  if (!markerPopoverCard || !detail) return;

  markerPopoverKicker.textContent = detail.kicker || "";
  markerPopoverTitle.textContent = detail.title || "Detail";
  markerPopoverMeta.textContent = (detail.meta || []).filter(Boolean).join(" | ");
  markerPopoverBody.textContent = detail.body || "No detail payload was captured for this item.";

  if (inspectorEmpty) inspectorEmpty.hidden = true;
  markerPopoverCard.hidden = false;
  if (target?.classList?.contains("span-clickable")) {
    document.querySelectorAll(".span-clickable.is-selected").forEach((node) => {
      node.classList.remove("is-selected");
    });
    target.classList.add("is-selected");
  }
}

function openMarkerPopover(marker, target) {
  if (!marker) return;
  openDetailPopover(
    {
      kicker: marker.label || marker.payloadType || marker.type || "event",
      title: markerKindLabel(marker.type),
      meta: [fmtDateTime(marker.ts), marker.lane, marker.sessionTitle || marker.sessionId],
      body: marker.detail || "No prompt or detail payload was captured for this marker.",
    },
    target,
  );
}

function spanKindLabel(type) {
  if (type === "wait") return "Wait";
  if (type === "spawn") return "Spawn tool";
  if (type === "leased") return "Active queue lease";
  if (type === "completed") return "Completed queue item";
  if (type === "queued") return "Queued item";
  if (type === "failed") return "Failed queue item";
  return "Tool call";
}

function spanPaintRank(type) {
  if (type === "spawn") return 5;
  if (type === "tool") return 10;
  if (type === "wait") return 30;
  return 0;
}

function openSpanPopover(span, target) {
  if (!span) return;
  const running = span.active || span.status === "running";
  const visualType = spanVisualType(span);
  openDetailPopover(
    {
      kicker: running ? "running" : visualType || span.type || "span",
      title: running ? `Running ${spanKindLabel(visualType).toLowerCase()}` : spanKindLabel(visualType),
      meta: [
        fmtDateTime(span.start),
        `${fmtDuration(span.durationMs)}${running ? " so far" : " duration"}`,
        span.wallMs == null ? "" : `${fmtDuration(span.wallMs)} wall`,
        span.exitCode == null ? "" : `exit ${span.exitCode}`,
        span.lane,
      ],
      body: span.detail || span.argsPreview || span.outputPreview || "No tool detail was captured for this span.",
    },
    target,
  );
}

function placeMarkerPopover(target) {
  if (markerPopoverCard?.closest?.(".detail-inspector")) return;
  const cardWidth = Math.min(540, Math.max(280, window.innerWidth - 24));
  markerPopoverCard.style.width = `${cardWidth}px`;

  const rect = target?.getBoundingClientRect?.();
  const defaultLeft = window.innerWidth - cardWidth - 16;
  const defaultTop = 16;
  const left = rect
    ? clamp(rect.left + 16, 12, window.innerWidth - cardWidth - 12)
    : defaultLeft;
  const top = rect
    ? clamp(rect.top + 16, 12, Math.max(12, window.innerHeight - 240))
    : defaultTop;

  markerPopoverCard.style.left = `${left}px`;
  markerPopoverCard.style.top = `${top}px`;
}

function validDomain(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end: end <= start ? start + 1 : end };
}

function domainFromPoints(points) {
  const filtered = points.filter(Number.isFinite);
  if (!filtered.length) return null;
  return validDomain(Math.min(...filtered), Math.max(...filtered));
}

function domainFromSessions(sessions) {
  const points = [];
  for (const session of sessions || []) {
    if (session.start) points.push(session.start);
    if (session.end) points.push(session.end);
    for (const span of session.spans || []) points.push(span.start, span.end);
    for (const marker of session.markers || []) points.push(marker.ts);
  }
  return domainFromPoints(points);
}

function fallbackDomain(data) {
  return validDomain(data?.domain?.start, data?.domain?.end) || validDomain(Date.now(), Date.now() + 1);
}

function timelineFullDomain(data) {
  return domainFromSessions(mainSessionRows(data)) || fallbackDomain(data);
}

function queueTimelineFullDomain(data) {
  const queue = data.queue || {};
  const points = [];
  for (const item of queue.items || []) {
    if (item.created) points.push(item.created);
    if (item.end) points.push(item.end);
    if (item.completed) points.push(item.completed);
  }
  for (const track of queue.timeline || []) {
    if (track.start) points.push(track.start);
    if (track.end) points.push(track.end);
  }
  return domainFromPoints(points) || timelineFullDomain(data);
}

function normalizeQueueTimelineWindow(start, end, data) {
  const full = queueTimelineFullDomain(data);
  const fullMs = Math.max(1, full.end - full.start);
  const minMs = Math.min(fullMs, MIN_TIMELINE_WINDOW_MS);
  let windowMs = Math.max(minMs, Math.min(fullMs, end - start || fullMs));
  let nextStart = Number.isFinite(start) ? start : full.start;
  let nextEnd = nextStart + windowMs;

  if (nextEnd > full.end) {
    nextEnd = full.end;
    nextStart = nextEnd - windowMs;
  }
  if (nextStart < full.start) {
    nextStart = full.start;
    nextEnd = nextStart + windowMs;
  }

  return { start: nextStart, end: nextEnd };
}

function getQueueTimelineView(data) {
  if (!queueTimelineView) {
    queueTimelineView = queueTimelineFullDomain(data);
  }
  queueTimelineView = normalizeQueueTimelineWindow(queueTimelineView.start, queueTimelineView.end, data);
  return queueTimelineView;
}

function setQueueTimelineWindow(start, end) {
  if (!currentData) return;
  queueTimelineView = normalizeQueueTimelineWindow(start, end, currentData);
  renderQueueTimeline(currentData);
}

function resetQueueTimeline() {
  if (!currentData) return;
  queueTimelineView = queueTimelineFullDomain(currentData);
  renderQueueTimeline(currentData);
}

function zoomQueueTimeline(factor) {
  if (!currentData) return;
  const view = getQueueTimelineView(currentData);
  const center = view.start + (view.end - view.start) / 2;
  const nextSpan = (view.end - view.start) * factor;
  setQueueTimelineWindow(center - nextSpan / 2, center + nextSpan / 2);
}

function panQueueTimeline(fraction) {
  if (!currentData) return;
  const view = getQueueTimelineView(currentData);
  const shift = (view.end - view.start) * fraction;
  setQueueTimelineWindow(view.start + shift, view.end + shift);
}

function queueTimelineIsFull(data) {
  const view = getQueueTimelineView(data);
  const full = queueTimelineFullDomain(data);
  return Math.abs(view.start - full.start) < 1 && Math.abs(view.end - full.end) < 1;
}

function updateQueueTimelineControls(data) {
  if (!queueTimelineReadout) return;
  const view = getQueueTimelineView(data);
  const full = queueTimelineFullDomain(data);
  const viewMs = view.end - view.start;
  const fullMs = full.end - full.start;
  const minMs = Math.min(fullMs, MIN_TIMELINE_WINDOW_MS);
  const isFull = queueTimelineIsFull(data);

  queueTimelineReadout.textContent = isFull
    ? `Full range: ${fmtDuration(fullMs)}`
    : `${fmtDuration(viewMs)} window: ${fmtDateTime(view.start)} to ${fmtDateTime(view.end)}`;
  if (queueTimelineZoomOut) queueTimelineZoomOut.disabled = isFull;
  if (queueTimelineReset) queueTimelineReset.disabled = isFull;
  if (queueTimelineZoomIn) queueTimelineZoomIn.disabled = viewMs <= minMs + 1;
  if (queueTimelinePanLeft) queueTimelinePanLeft.disabled = view.start <= full.start + 1;
  if (queueTimelinePanRight) queueTimelinePanRight.disabled = view.end >= full.end - 1;
}

function normalizeTimelineWindow(start, end, data) {
  const full = timelineFullDomain(data);
  const fullMs = Math.max(1, full.end - full.start);
  const minMs = Math.min(fullMs, MIN_TIMELINE_WINDOW_MS);
  let windowMs = Math.max(minMs, Math.min(fullMs, end - start || fullMs));
  let nextStart = Number.isFinite(start) ? start : full.start;
  let nextEnd = nextStart + windowMs;

  if (nextEnd > full.end) {
    nextEnd = full.end;
    nextStart = nextEnd - windowMs;
  }
  if (nextStart < full.start) {
    nextStart = full.start;
    nextEnd = nextStart + windowMs;
  }

  return { start: nextStart, end: nextEnd };
}

function getTimelineView(data) {
  if (!timelineView) {
    timelineView = timelineFullDomain(data);
  }
  timelineView = normalizeTimelineWindow(timelineView.start, timelineView.end, data);
  return timelineView;
}

function setTimelineWindow(start, end) {
  if (!currentData) return;
  timelineView = normalizeTimelineWindow(start, end, currentData);
  renderTimeline(currentData);
  updateTimelineControls(currentData);
}

function zoomTimeline(factor) {
  if (!currentData) return;
  const view = getTimelineView(currentData);
  const center = view.start + (view.end - view.start) / 2;
  const nextSpan = (view.end - view.start) * factor;
  setTimelineWindow(center - nextSpan / 2, center + nextSpan / 2);
}

function panTimeline(fraction) {
  if (!currentData) return;
  const view = getTimelineView(currentData);
  const shift = (view.end - view.start) * fraction;
  setTimelineWindow(view.start + shift, view.end + shift);
}

function resetTimeline() {
  if (!currentData) return;
  timelineView = timelineFullDomain(currentData);
  renderTimeline(currentData);
  updateTimelineControls(currentData);
}

function focusActiveSpan() {
  if (!currentData) return false;
  const active = activeSpansForData(currentData);
  if (!active.length) return false;
  const newest = active[active.length - 1];
  const full = timelineFullDomain(currentData);
  const center = newest.start + Math.max(1, newest.durationMs || 1) / 2;
  const windowMs = Math.min(full.end - full.start, Math.max(MIN_TIMELINE_WINDOW_MS, (newest.durationMs || 0) * 3));
  setTimelineWindow(center - windowMs / 2, center + windowMs / 2);
  return true;
}

function timelineIsFull(data) {
  const view = getTimelineView(data);
  const full = timelineFullDomain(data);
  return Math.abs(view.start - full.start) < 1 && Math.abs(view.end - full.end) < 1;
}

function updateTimelineControls(data) {
  if (!timelineReadout) return;
  const view = getTimelineView(data);
  const full = timelineFullDomain(data);
  const viewMs = view.end - view.start;
  const fullMs = full.end - full.start;
  const minMs = Math.min(fullMs, MIN_TIMELINE_WINDOW_MS);
  const isFull = timelineIsFull(data);

  timelineReadout.textContent = isFull
    ? `Full range: ${fmtDuration(fullMs)}`
    : `${fmtDuration(viewMs)} window: ${fmtDateTime(view.start)} to ${fmtDateTime(view.end)}`;
  timelineZoomOut.disabled = isFull;
  timelineReset.disabled = isFull;
  timelineZoomIn.disabled = viewMs <= minMs + 1;
  timelinePanLeft.disabled = view.start <= full.start + 1;
  timelinePanRight.disabled = view.end >= full.end - 1;
}

function clipRange(start, end, domainStart, domainEnd) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < domainStart || start > domainEnd) {
    return null;
  }
  return {
    start: Math.max(start, domainStart),
    end: Math.min(end, domainEnd),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function timelineSvg() {
  return timelineWrap.querySelector(".timeline-svg");
}

function timelinePlotFromSvg(svg) {
  return {
    domainStart: Number(svg.dataset.domainStart),
    domainEnd: Number(svg.dataset.domainEnd),
    left: Number(svg.dataset.plotLeft),
    right: Number(svg.dataset.plotRight),
    top: Number(svg.dataset.selectTop),
    bottom: Number(svg.dataset.selectBottom),
  };
}

function pointerToSvgX(event, svg) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  return viewBox.x + ((event.clientX - rect.left) / rect.width) * viewBox.width;
}

function svgXToTime(x, svg) {
  const plot = timelinePlotFromSvg(svg);
  const clampedX = clamp(x, plot.left, plot.right);
  const fraction = (clampedX - plot.left) / Math.max(1, plot.right - plot.left);
  return plot.domainStart + fraction * (plot.domainEnd - plot.domainStart);
}

function minimapSvg() {
  return timelineMinimap?.querySelector(".minimap-svg");
}

function minimapPlotFromSvg(svg) {
  return {
    domainStart: Number(svg.dataset.domainStart),
    domainEnd: Number(svg.dataset.domainEnd),
    left: Number(svg.dataset.plotLeft),
    right: Number(svg.dataset.plotRight),
  };
}

function minimapXToTime(x, svg) {
  const plot = minimapPlotFromSvg(svg);
  const clampedX = clamp(x, plot.left, plot.right);
  const fraction = (clampedX - plot.left) / Math.max(1, plot.right - plot.left);
  return plot.domainStart + fraction * (plot.domainEnd - plot.domainStart);
}

function minimapTimeToX(ms, svg) {
  const plot = minimapPlotFromSvg(svg);
  const fraction = (ms - plot.domainStart) / Math.max(1, plot.domainEnd - plot.domainStart);
  return plot.left + fraction * (plot.right - plot.left);
}

function minimapSelectionRange(svg) {
  const selection = svg.querySelector(".minimap-selection");
  const x = Number(selection?.getAttribute("x"));
  const width = Number(selection?.getAttribute("width"));
  if (Number.isFinite(x) && Number.isFinite(width)) {
    return {
      startX: x,
      endX: x + width,
      width,
    };
  }

  const plot = minimapPlotFromSvg(svg);
  const view = currentData ? getTimelineView(currentData) : { start: plot.domainStart, end: plot.domainEnd };
  const startX = minimapTimeToX(view.start, svg);
  const endX = minimapTimeToX(view.end, svg);
  return {
    startX,
    endX,
    width: Math.max(0, endX - startX),
  };
}

function minimapDragMode(startX, range) {
  const nearStart = Math.abs(startX - range.startX) <= MINIMAP_HANDLE_HIT_PX;
  const nearEnd = Math.abs(startX - range.endX) <= MINIMAP_HANDLE_HIT_PX;

  if (nearStart && nearEnd) {
    return Math.abs(startX - range.startX) <= Math.abs(startX - range.endX)
      ? "resize-start"
      : "resize-end";
  }
  if (nearStart) return "resize-start";
  if (nearEnd) return "resize-end";
  if (startX > range.startX && startX < range.endX) return "pan";
  return "select";
}

function setMinimapDragClasses(mode = "") {
  if (!timelineMinimap) return;
  timelineMinimap.classList.toggle("is-selecting", Boolean(mode));
  timelineMinimap.classList.toggle("is-resizing", mode === "resize-start" || mode === "resize-end");
  timelineMinimap.classList.toggle("is-panning", mode === "pan");
}

function updateMinimapSelectionPreview(svg, startX, endX) {
  const x1 = Math.min(startX, endX);
  const x2 = Math.max(startX, endX);
  const selection = svg.querySelector(".minimap-selection");
  if (selection) {
    selection.setAttribute("x", x1.toFixed(2));
    selection.setAttribute("width", Math.max(4, x2 - x1).toFixed(2));
  }

  const leftHandle = svg.querySelector(".minimap-handle-left");
  const rightHandle = svg.querySelector(".minimap-handle-right");
  const leftHit = svg.querySelector(".minimap-handle-hit-left");
  const rightHit = svg.querySelector(".minimap-handle-hit-right");
  leftHandle?.setAttribute("x", (x1 - 3).toFixed(2));
  rightHandle?.setAttribute("x", (x2 - 3).toFixed(2));
  leftHit?.setAttribute("x", (x1 - MINIMAP_HANDLE_HIT_PX).toFixed(2));
  rightHit?.setAttribute("x", (x2 - MINIMAP_HANDLE_HIT_PX).toFixed(2));
}

function updateMinimapDrag(event) {
  if (!minimapDrag) return;
  const { svg, startX, mode, originalStartX, originalEndX } = minimapDrag;
  const plot = minimapPlotFromSvg(svg);
  const currentX = clamp(pointerToSvgX(event, svg), plot.left, plot.right);
  const minWidth = MINIMAP_DRAG_MIN_PX;
  let previewStartX = Math.min(startX, currentX);
  let previewEndX = Math.max(startX, currentX);

  if (mode === "resize-start") {
    previewStartX = clamp(currentX, plot.left, originalEndX - minWidth);
    previewEndX = originalEndX;
  } else if (mode === "resize-end") {
    previewStartX = originalStartX;
    previewEndX = clamp(currentX, originalStartX + minWidth, plot.right);
  } else if (mode === "pan") {
    const width = Math.max(minWidth, originalEndX - originalStartX);
    const nextStartX = clamp(originalStartX + (currentX - startX), plot.left, plot.right - width);
    previewStartX = nextStartX;
    previewEndX = nextStartX + width;
  }

  minimapDrag.currentX = currentX;
  minimapDrag.previewStartX = previewStartX;
  minimapDrag.previewEndX = previewEndX;
  updateMinimapSelectionPreview(svg, previewStartX, previewEndX);
}

function startMinimapDrag(event) {
  if (!currentData || event.button !== 0) return;
  const svg = event.target.closest?.(".minimap-svg");
  if (!svg) return;
  const plot = minimapPlotFromSvg(svg);
  const startX = clamp(pointerToSvgX(event, svg), plot.left, plot.right);
  const range = minimapSelectionRange(svg);
  const mode = minimapDragMode(startX, range);
  event.preventDefault();
  svg.setPointerCapture?.(event.pointerId);
  minimapDrag = {
    pointerId: event.pointerId,
    svg,
    mode,
    startX,
    currentX: startX,
    originalStartX: range.startX,
    originalEndX: range.endX,
    previewStartX: range.startX,
    previewEndX: range.endX,
  };
  setMinimapDragClasses(mode);
  updateMinimapDrag(event);
}

function moveMinimapDrag(event) {
  if (!minimapDrag || event.pointerId !== minimapDrag.pointerId) return;
  event.preventDefault();
  updateMinimapDrag(event);
}

function finishMinimapDrag(event) {
  if (!minimapDrag || event.pointerId !== minimapDrag.pointerId) return;
  event.preventDefault();
  const { svg, mode, previewStartX, previewEndX } = minimapDrag;
  svg.releasePointerCapture?.(event.pointerId);
  setMinimapDragClasses("");
  minimapDrag = null;
  const width = Math.abs(previewEndX - previewStartX);
  if (mode === "select" && width < MINIMAP_DRAG_MIN_PX) {
    if (currentData) renderTimelineMinimap(currentData);
    return;
  }
  const start = minimapXToTime(previewStartX, svg);
  const end = minimapXToTime(previewEndX, svg);
  setTimelineWindow(start, end);
}

function getSelectionRect(svg) {
  let rect = svg.querySelector(".timeline-selection");
  if (!rect) {
    rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("class", "timeline-selection");
    rect.setAttribute("rx", "5");
    svg.appendChild(rect);
  }
  return rect;
}

function updateDragSelection(event) {
  if (!timelineDrag) return;
  const { svg, startX } = timelineDrag;
  const plot = timelinePlotFromSvg(svg);
  const currentX = clamp(pointerToSvgX(event, svg), plot.left, plot.right);
  timelineDrag.currentX = currentX;

  const x1 = Math.min(startX, currentX);
  const x2 = Math.max(startX, currentX);
  const rect = getSelectionRect(svg);
  rect.setAttribute("x", x1.toFixed(2));
  rect.setAttribute("y", plot.top.toFixed(2));
  rect.setAttribute("width", Math.max(1, x2 - x1).toFixed(2));
  rect.setAttribute("height", Math.max(1, plot.bottom - plot.top).toFixed(2));

  const startTime = svgXToTime(x1, svg);
  const endTime = svgXToTime(x2, svg);
  timelineReadout.textContent =
    `${fmtDuration(endTime - startTime)} selection: ${fmtDateTime(startTime)} to ${fmtDateTime(endTime)}`;
}

function clearDragSelection() {
  const rect = timelineSvg()?.querySelector(".timeline-selection");
  if (rect) rect.remove();
  timelineWrap.classList.remove("is-selecting");
  timelineDrag = null;
}

function startTimelineDrag(event) {
  if (!currentData || event.button !== 0) return;
  if (event.target.closest?.(".marker-clickable, .span-clickable, .lane-clickable")) return;
  const svg = event.target.closest(".timeline-svg");
  if (!svg) return;
  const plot = timelinePlotFromSvg(svg);
  const startX = pointerToSvgX(event, svg);
  if (startX < plot.left || startX > plot.right) return;

  event.preventDefault();
  svg.setPointerCapture?.(event.pointerId);
  timelineWrap.classList.add("is-selecting");
  timelineDrag = {
    pointerId: event.pointerId,
    svg,
    startX: clamp(startX, plot.left, plot.right),
    currentX: clamp(startX, plot.left, plot.right),
  };
  updateDragSelection(event);
}

function moveTimelineDrag(event) {
  if (!timelineDrag || event.pointerId !== timelineDrag.pointerId) return;
  event.preventDefault();
  updateDragSelection(event);
}

function finishTimelineDrag(event) {
  if (!timelineDrag || event.pointerId !== timelineDrag.pointerId) return;
  event.preventDefault();
  const { svg, startX, currentX } = timelineDrag;
  const width = Math.abs(currentX - startX);
  const startTime = svgXToTime(Math.min(startX, currentX), svg);
  const endTime = svgXToTime(Math.max(startX, currentX), svg);
  svg.releasePointerCapture?.(event.pointerId);
  clearDragSelection();

  if (width >= DRAG_ZOOM_MIN_PX && endTime > startTime) {
    setTimelineWindow(startTime, endTime);
  } else if (currentData) {
    updateTimelineControls(currentData);
  }
}

function queueTimelineSvg() {
  return queueTimelineWrap?.querySelector(".queue-timeline-svg");
}

function updateQueueTimelineDrag(event) {
  if (!queueTimelineDrag) return;
  const { svg, startX } = queueTimelineDrag;
  const plot = timelinePlotFromSvg(svg);
  const currentX = clamp(pointerToSvgX(event, svg), plot.left, plot.right);
  queueTimelineDrag.currentX = currentX;

  const x1 = Math.min(startX, currentX);
  const x2 = Math.max(startX, currentX);
  const rect = getSelectionRect(svg);
  rect.setAttribute("x", x1.toFixed(2));
  rect.setAttribute("y", plot.top.toFixed(2));
  rect.setAttribute("width", Math.max(1, x2 - x1).toFixed(2));
  rect.setAttribute("height", Math.max(1, plot.bottom - plot.top).toFixed(2));

  const startTime = svgXToTime(x1, svg);
  const endTime = svgXToTime(x2, svg);
  if (queueTimelineReadout) {
    queueTimelineReadout.textContent =
      `${fmtDuration(endTime - startTime)} selection: ${fmtDateTime(startTime)} to ${fmtDateTime(endTime)}`;
  }
}

function clearQueueTimelineDrag() {
  const rect = queueTimelineSvg()?.querySelector(".timeline-selection");
  if (rect) rect.remove();
  queueTimelineWrap?.classList.remove("is-selecting");
  queueTimelineDrag = null;
}

function startQueueTimelineDrag(event) {
  if (!currentData || event.button !== 0) return;
  if (event.target.closest?.(".queue-clickable, .queue-activity-clickable, .queue-lane-clickable")) return;
  const svg = event.target.closest?.(".queue-timeline-svg");
  if (!svg) return;
  const plot = timelinePlotFromSvg(svg);
  const startX = pointerToSvgX(event, svg);
  if (startX < plot.left || startX > plot.right) return;

  event.preventDefault();
  svg.setPointerCapture?.(event.pointerId);
  queueTimelineWrap?.classList.add("is-selecting");
  queueTimelineDrag = {
    pointerId: event.pointerId,
    svg,
    startX: clamp(startX, plot.left, plot.right),
    currentX: clamp(startX, plot.left, plot.right),
  };
  updateQueueTimelineDrag(event);
}

function moveQueueTimelineDrag(event) {
  if (!queueTimelineDrag || event.pointerId !== queueTimelineDrag.pointerId) return;
  event.preventDefault();
  updateQueueTimelineDrag(event);
}

function finishQueueTimelineDrag(event) {
  if (!queueTimelineDrag || event.pointerId !== queueTimelineDrag.pointerId) return;
  event.preventDefault();
  const { svg, startX, currentX } = queueTimelineDrag;
  const width = Math.abs(currentX - startX);
  const startTime = svgXToTime(Math.min(startX, currentX), svg);
  const endTime = svgXToTime(Math.max(startX, currentX), svg);
  svg.releasePointerCapture?.(event.pointerId);
  clearQueueTimelineDrag();

  if (width >= DRAG_ZOOM_MIN_PX && endTime > startTime) {
    setQueueTimelineWindow(startTime, endTime);
  } else if (currentData) {
    updateQueueTimelineControls(currentData);
  }
}

function renderTimeline(data) {
  markerLookup = new Map();
  spanLookup = new Map();
  laneLookup = new Map();
  const width = Math.max(980, timelineWrap.clientWidth || 980);
  const left = Math.round(Math.min(340, Math.max(280, width * 0.22)));
  const right = 24;
  const top = 34;
  const laneH = 32;
  const axisH = 28;
  const usable = width - left - right;
  const view = getTimelineView(data);
  const domainStart = view.start;
  const domainEnd = view.end;
  const domainMs = Math.max(1, domainEnd - domainStart);
  const x = (ms) => left + ((ms - domainStart) / domainMs) * usable;
  const lanes = [];
  let markerCounter = 0;
  let spanCounter = 0;
  let laneCounter = 0;

  lanes.push({
    label: `parent: ${data.session.title || data.session.id.slice(0, 8)}`,
    kind: "session",
    session: data.session,
  });
  for (const child of timelineChildRows(data)) {
    const display = childSessionDisplay(child);
    const depth = Math.max(1, Number(child.depth || 1));
    const parentLabel = child.parentSessionLabel || child.parentSessionId || "";
    const nestedPrefix = depth > 1 && parentLabel ? `via ${parentLabel}: ` : "";
    lanes.push({
      label: `${nestedPrefix}${display.lanePrefix}: ${display.name}`,
      kind: "session",
      session: child,
      depth,
      labelKind: depth > 1 ? "nested-agent" : "",
    });
  }
  for (const thread of data.appThreads || []) {
    const display = childSessionDisplay(thread);
    lanes.push({
      label: `${display.lanePrefix}: ${display.name}`,
      labelKind: display.lanePrefix === "app worker" ? "app-worker" : "app-thread",
      kind: "session",
      session: thread,
    });
  }

  const height = top + axisH + lanes.length * laneH + 18;
  const ticks = 6;
  const tickEls = Array.from({ length: ticks + 1 }, (_, i) => {
    const ms = domainStart + (domainMs / ticks) * i;
    const tx = x(ms);
    return `
      <line x1="${tx}" y1="18" x2="${tx}" y2="${height - 10}" stroke="#edf0f5" />
      <text class="axis-label" x="${tx}" y="14" text-anchor="${i === 0 ? "start" : i === ticks ? "end" : "middle"}">${esc(fmtAxisTime(ms, domainMs))}</text>
    `;
  }).join("");

  const laneEls = lanes
    .map((lane, index) => {
      const y = top + axisH + index * laneH;
      const label = laneLabelForDisplay(lane, left);
      const labelClass = lane.labelKind === "app-worker" || lane.labelKind === "nested-agent" ? "lane-label-compact" : "";
      const laneId =
        lane.kind === "session" &&
        (isAgentJobSession(lane.session) || isAppThreadSession(lane.session))
        ? `lane-${laneCounter++}`
        : "";
      if (laneId) {
        laneLookup.set(laneId, {
          label: lane.label,
          session: lane.session,
        });
      }
      let content = `
        ${laneLabelText(label, laneId, y + 19, labelClass, lane.label, 10 + Math.max(0, Number(lane.depth || 0) - 1) * 16)}
        <line class="lane-line" x1="${left}" y1="${y + 14}" x2="${width - right}" y2="${y + 14}" />
      `;

      if (lane.kind === "session") {
        const session = lane.session;
        const sessionRange = clipRange(session.start, session.end, domainStart, domainEnd);
        if (sessionRange) {
          content += rectWithTitle(
            x(sessionRange.start),
            y + 9,
            Math.max(2, x(sessionRange.end) - x(sessionRange.start)),
            10,
            "span-bg",
            `${session.title || session.id}: ${fmtDuration(session.elapsedMs)}`,
          );
        }
        const visibleSpans = (session.spans || [])
          .filter((span) => clipRange(span.start, span.end, domainStart, domainEnd))
          .filter(shouldShowSpan)
          .sort((a, b) => spanPaintRank(spanVisualType(a)) - spanPaintRank(spanVisualType(b)) || a.start - b.start);
        for (const span of visibleSpans) {
          const spanRange = clipRange(span.start, span.end, domainStart, domainEnd);
          const spanId = `span-${spanCounter++}`;
          const running = span.active || span.status === "running";
          const visualType = spanVisualType(span);
          spanLookup.set(spanId, {
            ...span,
            lane: lane.label,
            sessionId: session.id,
            sessionTitle: session.title || "",
          });
          const spanTitle = `${running ? "Running " : ""}${spanKindLabel(visualType)}: ${span.label}, ${fmtDuration(span.durationMs)}${running ? " so far" : ""}${span.exitCode == null ? "" : `, exit ${span.exitCode}`}`;
          content += interactiveRectWithTitle(
            x(spanRange.start),
            y + 7,
            Math.max(2, x(spanRange.end) - x(spanRange.start)),
            14,
            `${spanClass(visualType)}${running ? " span-running" : ""}`,
            spanTitle,
            spanId,
          );
        }
        const visibleMarkers = shouldShowMarker()
          ? (session.markers || [])
              .filter((marker) => marker.ts >= domainStart && marker.ts <= domainEnd)
              .sort((a, b) => markerPaintRank(a.type) - markerPaintRank(b.type) || a.ts - b.ts)
          : [];
        for (const marker of visibleMarkers) {
          const markerId = `marker-${markerCounter++}`;
          markerLookup.set(markerId, {
            ...marker,
            lane: lane.label,
            sessionId: session.id,
            sessionTitle: session.title || "",
          });
          const markerTitle = `${markerKindLabel(marker.type)}: ${marker.label} at ${fmtDateTime(marker.ts)}`;
          content += markerShape(marker, markerId, x(marker.ts), y + 25, markerTitle);
        }
      }
      return content;
    })
    .join("");

  timelineWrap.innerHTML = `
    <svg
      class="timeline-svg"
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="Session timeline"
      data-domain-start="${domainStart}"
      data-domain-end="${domainEnd}"
      data-plot-left="${left}"
      data-plot-right="${width - right}"
      data-select-top="18"
      data-select-bottom="${height - 10}"
    >
      ${tickEls}
      ${laneEls}
    </svg>
  `;
  renderTimelineMinimap(data);
  updateTimelineControls(data);
}

function renderTimelineMinimap(data) {
  if (!timelineMinimap) return;
  const sessions = timelineSessionRows(data);
  const full = timelineFullDomain(data);
  const view = getTimelineView(data);
  const width = Math.max(720, timelineMinimap.clientWidth || timelineWrap.clientWidth || 720);
  const height = 126;
  const left = 12;
  const right = 12;
  const top = 14;
  const laneGap = 4;
  const laneH = Math.max(8, Math.min(15, Math.floor((height - 34) / Math.max(1, sessions.length))));
  const usable = width - left - right;
  const domainMs = Math.max(1, full.end - full.start);
  const x = (ms) => left + ((ms - full.start) / domainMs) * usable;
  const viewX = x(view.start);
  const viewW = Math.max(8, x(view.end) - viewX);

  const laneEls = sessions
    .slice(0, 9)
    .map((session, index) => {
      const y = top + index * (laneH + laneGap);
      const spans = (session.spans || [])
        .filter(shouldShowSpan)
        .map((span) => {
          const range = clipRange(span.start, span.end, full.start, full.end);
          if (!range) return "";
          return rectWithTitle(
            x(range.start),
            y,
            Math.max(1, x(range.end) - x(range.start)),
            laneH,
            `minimap-span ${spanClass(spanVisualType(span))}`,
            `${spanKindLabel(spanVisualType(span))}: ${span.label || span.name || ""}`,
          );
        })
        .join("");
      const markers = shouldShowMarker()
        ? (session.markers || [])
            .filter((marker) => marker.ts >= full.start && marker.ts <= full.end)
            .map((marker) => `<circle class="minimap-marker" cx="${x(marker.ts).toFixed(2)}" cy="${(y + laneH / 2).toFixed(2)}" r="1.6" fill="${markerColor(marker.type)}"></circle>`)
            .join("")
        : "";
      return `<g>${spans}${markers}</g>`;
    })
    .join("");

  timelineMinimap.innerHTML = `
    <svg
      class="minimap-svg"
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="Timeline overview brush"
      data-domain-start="${full.start}"
      data-domain-end="${full.end}"
      data-plot-left="${left}"
      data-plot-right="${width - right}"
    >
      <rect class="minimap-bg" x="${left}" y="8" width="${usable}" height="${height - 16}" rx="7"></rect>
      ${laneEls}
      <rect class="minimap-selection" x="${viewX.toFixed(2)}" y="8" width="${viewW.toFixed(2)}" height="${height - 16}" rx="7"></rect>
      <rect class="minimap-handle-hit minimap-handle-hit-left" x="${(viewX - MINIMAP_HANDLE_HIT_PX).toFixed(2)}" y="8" width="${MINIMAP_HANDLE_HIT_PX * 2}" height="${height - 16}"></rect>
      <rect class="minimap-handle-hit minimap-handle-hit-right" x="${(viewX + viewW - MINIMAP_HANDLE_HIT_PX).toFixed(2)}" y="8" width="${MINIMAP_HANDLE_HIT_PX * 2}" height="${height - 16}"></rect>
      <rect class="minimap-handle minimap-handle-left" x="${(viewX - 3).toFixed(2)}" y="${height / 2 - 18}" width="6" height="36" rx="3"></rect>
      <rect class="minimap-handle minimap-handle-right" x="${(viewX + viewW - 3).toFixed(2)}" y="${height / 2 - 18}" width="6" height="36" rx="3"></rect>
    </svg>
  `;
}

function queueKey(namespace, queueName) {
  return `${namespace || ""}\0${queueName || ""}`;
}

function queueStatusRank(status) {
  return { leased: 0, failed: 1, queued: 2, completed: 3 }[status] ?? 9;
}

function sortQueueSamples(a, b) {
  const statusDiff = queueStatusRank(a.status) - queueStatusRank(b.status);
  if (statusDiff) return statusDiff;
  const latencyDiff = (b.latencyMs || 0) - (a.latencyMs || 0);
  if (latencyDiff) return latencyDiff;
  const aTs = a.updated || a.completed || a.end || a.created || 0;
  const bTs = b.updated || b.completed || b.end || b.created || 0;
  return bTs - aTs;
}

function dominantQueueStatus(bin) {
  let winner = "queued";
  let best = -1;
  for (const status of ["failed", "leased", "queued", "completed"]) {
    const count = Number(bin[status] || 0);
    if (count > best) {
      best = count;
      winner = status;
    }
  }
  return winner;
}

function queueBinTitle(queueName, bin) {
  return [
    `${queueName}: ${fmtCount(bin.total)} active item${bin.total === 1 ? "" : "s"}`,
    `${fmtDateTime(bin.start)} to ${fmtDateTime(bin.end)}`,
    `completed ${fmtCount(bin.completed || 0)}`,
    `leased ${fmtCount(bin.leased || 0)}`,
    `queued ${fmtCount(bin.queued || 0)}`,
    `failed ${fmtCount(bin.failed || 0)}`,
  ].join(", ");
}

function queueItemDetail(item) {
  return [
    `Queue: ${item.queueName}`,
    `Item: ${item.label} (${item.id})`,
    `Status: ${item.status}`,
    item.workerId ? `Worker: ${item.workerId}` : "",
    item.leaseOwner ? `Lease owner: ${item.leaseOwner}` : "",
    `Created: ${item.created ? fmtDateTime(item.created) : "unknown"}`,
    item.updated ? `Updated: ${fmtDateTime(item.updated)}` : "",
    item.completed ? `Completed: ${fmtDateTime(item.completed)}` : "",
    item.leaseExpires ? `Lease expires: ${fmtDateTime(item.leaseExpires)}` : "",
    `Observed lifetime: ${fmtDuration(item.latencyMs || 0)}`,
    `Attempts: ${item.attempts || 0}/${item.maxAttempts || 0}`,
    item.idempotencyKey ? `Idempotency key: ${item.idempotencyKey}` : "",
    item.instructions ? `Instructions:\n${item.instructions}` : "",
    item.payloadPreview ? `Payload:\n${item.payloadPreview}` : "",
    item.resultPreview ? `Result:\n${item.resultPreview}` : "",
    item.error ? `Error:\n${item.error}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function openQueueItemPopover(item, target) {
  if (!item) return;
  openDetailPopover(
    {
      kicker: item.status || "queue item",
      title: `${item.queueName}: ${item.label}`,
      meta: [
        fmtDateTime(item.created),
        fmtDuration(item.latencyMs || 0),
        item.workerId ? `worker ${item.workerId}` : "",
      ],
      body: queueItemDetail(item),
    },
    target,
  );
}

function queueActivityDetail(activity) {
  const queue = activity.queue || {};
  const counts = queue.counts || {};
  const track = activity.track || {};
  const bin = activity.bin || null;
  const displayName = activity.displayName || queueNameForDisplay(queue.name || track.name || "queue");
  const fullName = activity.fullName || queue.name || track.name || "";
  const lines = [
    `Queue: ${displayName}`,
    fullName && fullName !== displayName ? `Full queue ID: ${fullName}` : "",
    queue.namespace ? `Namespace: ${queue.namespace}` : "",
    queue.status ? `Job status: ${queue.status}` : "",
    queue.source ? `Source: ${queue.source === "codex-security" ? "Codex Security DB" : queue.source}` : "",
    queue.workerCount != null ? `Workers observed: ${fmtCount(queue.workerCount)}` : "",
    "",
    "Totals",
    `Total items: ${fmtCount(counts.total || track.itemCount || 0)}`,
    `Completed: ${fmtCount(counts.completed || 0)}`,
    `Leased: ${fmtCount(counts.leased || 0)}`,
    `Queued: ${fmtCount(counts.queued || 0)}`,
    `Failed: ${fmtCount(counts.failed || 0)}`,
    counts.cancelled ? `Cancelled: ${fmtCount(counts.cancelled)}` : "",
    queue.sampleRowsLoaded != null ? `Detailed samples loaded: ${fmtCount(queue.sampleRowsLoaded)}` : "",
    track.itemCount != null ? `Timeline samples aggregated: ${fmtCount(track.itemCount)}` : "",
    "",
    "What this row shows",
    "Each bar segment is an aggregate time bucket from sampled queue-item lifetimes. Darker segments mean more queue items were active in that bucket relative to this queue's busiest bucket.",
  ];

  if (bin) {
    lines.push(
      "",
      "Selected bucket",
      `${fmtDateTime(bin.start)} to ${fmtDateTime(bin.end)}`,
      `Duration: ${fmtDuration(Math.max(0, (bin.end || 0) - (bin.start || 0)))}`,
      `Active sampled items: ${fmtCount(bin.total || 0)}`,
      `Completed in/through bucket: ${fmtCount(bin.completed || 0)}`,
      `Leased in/through bucket: ${fmtCount(bin.leased || 0)}`,
      `Queued in/through bucket: ${fmtCount(bin.queued || 0)}`,
      `Failed in/through bucket: ${fmtCount(bin.failed || 0)}`,
      `Dominant state: ${dominantQueueStatus(bin)}`,
    );
  } else {
    lines.push(
      "",
      "Track range",
      track.start ? `First sampled activity: ${fmtDateTime(track.start)}` : "",
      track.end ? `Last sampled activity: ${fmtDateTime(track.end)}` : "",
      track.maxBinTotal != null ? `Busiest bucket: ${fmtCount(track.maxBinTotal)} active sampled item${track.maxBinTotal === 1 ? "" : "s"}` : "",
    );
  }

  return lines.filter(Boolean).join("\n");
}

function openQueueActivityPopover(activity, target) {
  if (!activity) return;
  const queue = activity.queue || {};
  const track = activity.track || {};
  const bin = activity.bin || null;
  const displayName = activity.displayName || queueNameForDisplay(queue.name || track.name || "queue");
  openDetailPopover(
    {
      kicker: bin ? "Queue bucket" : "Queue workload",
      title: displayName,
      meta: [
        bin ? `${fmtDateTime(bin.start)} - ${fmtDateTime(bin.end)}` : "",
        bin ? `${fmtCount(bin.total || 0)} active samples` : `${fmtCount(queue.counts?.total || track.itemCount || 0)} total items`,
        queue.workerCount ? `${fmtCount(queue.workerCount)} workers` : "",
      ],
      body: queueActivityDetail(activity),
    },
    target,
  );
}

function renderQueueTimeline(data) {
  if (!queueTimelineCard || !queueTimelineWrap || !queueTimelineCaption) return;
  queueItemLookup = new Map();
  queueActivityLookup = new Map();
  queueLaneLookup = new Map();
  const queue = data.queue || {};
  const queues = queue.queues || [];
  const items = queue.items || [];
  const tracks = queue.timeline || [];
  if (!queues.length && !tracks.length && !items.length) {
    queueTimelineCard.hidden = true;
    queueTimelineWrap.innerHTML = "";
    return;
  }

  const width = Math.max(980, queueTimelineWrap.clientWidth || timelineWrap.clientWidth || 980);
  const left = Math.round(Math.min(340, Math.max(280, width * 0.22)));
  const right = 24;
  const top = 34;
  const laneH = 30;
  const axisH = 28;
  const usable = width - left - right;
  const view = getQueueTimelineView(data);
  const domainStart = view.start;
  const domainEnd = view.end;
  const domainMs = Math.max(1, domainEnd - domainStart);
  const x = (ms) => left + ((ms - domainStart) / domainMs) * usable;

  const trackByQueue = new Map(tracks.map((track) => [queueKey(track.namespace, track.name), track]));
  const queueByKey = new Map(
    queues.map((q) => [queueKey(q.namespace, q.name), q]),
  );
  for (const track of tracks) {
    const key = queueKey(track.namespace, track.name);
    if (!queueByKey.has(key)) {
      queueByKey.set(key, {
        namespace: track.namespace,
        name: track.name,
        counts: { total: track.itemCount || 0 },
      });
    }
  }

  const lanes = [];
  for (const q of [...queueByKey.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const track = trackByQueue.get(queueKey(q.namespace, q.name));
    const displayName = queueNameForDisplay(q.name);
    if (track) {
      lanes.push({
        label: `queue: ${displayName}`,
        kind: "queueActivity",
        queue: q,
        track,
        displayName,
        fullName: q.name,
        labelKind: "queue-activity",
      });
    }
  }

  const visibleSamples = items
    .slice()
    .filter((item) => item.status !== "completed")
    .filter((item) => clipRange(item.created, item.end, domainStart, domainEnd))
    .sort(sortQueueSamples);
  const itemLimit = 40;
  const sampleItems = visibleSamples.slice(0, itemLimit);
  lanes.push(
    ...sampleItems.map((item) => ({
      label: `${item.status}: ${compactPath(item.label)}`,
      kind: "queueItem",
      item,
      labelKind: "queue-sample",
    })),
  );

  const totalItems = queue.itemRowsTotal || queue.stats?.total || items.length;
  const timelineRowsLoaded =
    queue.timelineRowsLoaded || tracks.reduce((sum, track) => sum + (track.itemCount || 0), 0);
  queueTimelineCaption.textContent = [
    `Shows when queue work happened, so you can compare worker throughput against parent waits and spot idle gaps.`,
    `Click a queue row or heatmap segment for counts and meaning; drag empty chart space to zoom into a time range.`,
    `Each queue row is an aggregate heatmap from ${fmtCount(timelineRowsLoaded)}${queue.timelineTruncated ? "+" : ""} sampled item lifetime${timelineRowsLoaded === 1 ? "" : "s"} across ${fmtCount(tracks.length || queueByKey.size)} queue${(tracks.length || queueByKey.size) === 1 ? "" : "s"}.`,
    visibleSamples.length > itemLimit
      ? `Showing ${fmtCount(itemLimit)} of ${fmtCount(visibleSamples.length)} active/problem item rows.`
      : visibleSamples.length
        ? `Showing ${fmtCount(visibleSamples.length)} active/problem item row${visibleSamples.length === 1 ? "" : "s"}.`
        : `Completed item samples are hidden; totals for all ${fmtCount(totalItems)} items are in Queue Progress above.`,
  ].join(" ");

  const height = top + axisH + lanes.length * laneH + 18;
  let queueItemCounter = 0;
  let queueActivityCounter = 0;
  let queueLaneCounter = 0;
  const ticks = 6;
  const tickEls = Array.from({ length: ticks + 1 }, (_, i) => {
    const ms = domainStart + (domainMs / ticks) * i;
    const tx = x(ms);
    return `
      <line x1="${tx}" y1="18" x2="${tx}" y2="${height - 10}" stroke="#edf0f5" />
      <text class="axis-label" x="${tx}" y="14" text-anchor="${i === 0 ? "start" : i === ticks ? "end" : "middle"}">${esc(fmtAxisTime(ms, domainMs))}</text>
    `;
  }).join("");

  const laneEls = lanes
    .map((lane, index) => {
      const y = top + axisH + index * laneH;
      const label = laneLabelForDisplay(lane, left);
      const laneId = lane.kind === "queueActivity" ? `queue-lane-${queueLaneCounter++}` : "";
      if (laneId) {
        queueLaneLookup.set(laneId, {
          queue: lane.queue,
          track: lane.track,
          displayName: lane.displayName,
          fullName: lane.fullName,
        });
      }
      let content = `
        ${lane.kind === "queueActivity"
          ? queueLaneLabelText(label, laneId, y + 19, lane.labelKind ? "lane-label-compact" : "", lane.label)
          : laneLabelText(label, "", y + 19, lane.labelKind ? "lane-label-compact" : "", lane.label)}
        <line class="lane-line" x1="${left}" y1="${y + 14}" x2="${width - right}" y2="${y + 14}" />
      `;

      if (lane.kind === "queueActivity") {
        const track = lane.track;
        for (const bin of track.bins || []) {
          const binRange = clipRange(bin.start, bin.end, domainStart, domainEnd);
          if (!binRange) continue;
          const status = dominantQueueStatus(bin);
          const density = clamp((bin.total || 0) / Math.max(1, track.maxBinTotal || 1), 0, 1);
          const opacity = (0.18 + density * 0.74).toFixed(2);
          const activityId = `queue-activity-${queueActivityCounter++}`;
          queueActivityLookup.set(activityId, {
            queue: lane.queue,
            track,
            bin,
            displayName: lane.displayName,
            fullName: lane.fullName,
          });
          content += interactiveQueueActivityRectWithTitle(
            x(binRange.start),
            y + 8,
            Math.max(1, x(binRange.end) - x(binRange.start)),
            12,
            `${spanClass(status)} queue-density-bin`,
            queueBinTitle(lane.displayName || track.name, bin),
            activityId,
            `opacity="${opacity}"`,
          );
        }
      } else if (lane.kind === "queueItem") {
        const item = lane.item;
        const itemRange = clipRange(item.created, item.end, domainStart, domainEnd);
        if (!itemRange) return content;
        const itemId = `queue-item-${queueItemCounter++}`;
        queueItemLookup.set(itemId, item);
        content += interactiveQueueRectWithTitle(
          x(itemRange.start),
          y + 7,
          Math.max(2, x(itemRange.end) - x(itemRange.start)),
          14,
          spanClass(item.status),
          `${item.queueName} / ${item.label}: ${item.status}, ${fmtDuration(item.latencyMs)}`,
          itemId,
        );
      }
      return content;
    })
    .join("");

  queueTimelineWrap.innerHTML = `
    <svg
      class="timeline-svg queue-timeline-svg"
      viewBox="0 0 ${width} ${height}"
      role="img"
      aria-label="Queue workload timeline"
      data-domain-start="${domainStart}"
      data-domain-end="${domainEnd}"
      data-plot-left="${left}"
      data-plot-right="${width - right}"
      data-select-top="18"
      data-select-bottom="${height - 10}"
    >
      ${tickEls}
      ${laneEls}
    </svg>
  `;
  updateQueueTimelineControls(data);
  queueTimelineCard.hidden = false;
}

function ellipsizeEnd(value, max) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function ellipsizeMiddle(value, max) {
  const text = String(value || "");
  if (text.length <= max) return text;
  const available = Math.max(4, max - 3);
  const tail = Math.ceil(available * 0.45);
  const head = Math.max(1, available - tail);
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function laneLabelForDisplay(lane, left) {
  const isCompactWorker = lane.labelKind === "app-worker" || lane.labelKind === "queue-worker";
  const max = isCompactWorker
    ? (left >= 300 ? 48 : 40)
    : (left >= 300 ? 52 : 44);
  const label = lane.label || "";

  if (!isCompactWorker) return ellipsizeEnd(label, max);

  const prefixMatch = label.match(/^((?:app|queue) (?:worker|thread):\s*)(.+)$/);
  if (!prefixMatch) return ellipsizeMiddle(label, max);
  const [, prefix, name] = prefixMatch;
  return `${prefix}${ellipsizeMiddle(name, Math.max(12, max - prefix.length))}`;
}

function laneLabelText(label, laneId, y, extraClass = "", fullLabel = label, x = 10) {
  const className = ["lane-label", extraClass].filter(Boolean).join(" ");
  if (!laneId) {
    return `<text class="${esc(className)}" x="${x}" y="${y}">${esc(label)}<title>${esc(fullLabel)}</title></text>`;
  }

  return `
    <text
      class="${esc(`${className} lane-clickable`)}"
      x="${x}"
      y="${y}"
      data-lane-id="${esc(laneId)}"
      tabindex="0"
      focusable="true"
      role="button"
      aria-label="${esc(`${fullLabel}. Click for task summary.`)}"
    >
      ${esc(label)}
      <title>${esc(`${fullLabel}. Click for task summary.`)}</title>
    </text>
  `;
}

function queueLaneLabelText(label, laneId, y, extraClass = "", fullLabel = label, x = 10) {
  const className = ["lane-label", extraClass, "queue-lane-clickable"].filter(Boolean).join(" ");
  return `
    <text
      class="${esc(`${className} lane-clickable`)}"
      x="${x}"
      y="${y}"
      data-queue-lane-id="${esc(laneId)}"
      tabindex="0"
      focusable="true"
      role="button"
      aria-label="${esc(`${fullLabel}. Click for queue workload summary.`)}"
    >
      ${esc(label)}
      <title>${esc(`${fullLabel}. Click for queue workload summary.`)}</title>
    </text>
  `;
}

function rectWithTitle(x, y, width, height, className, title) {
  return `
    <rect class="${className}" x="${Number(x).toFixed(2)}" y="${y}" width="${Number(width).toFixed(2)}" height="${height}" rx="4">
      <title>${esc(title)}</title>
    </rect>
  `;
}

function rectWithTitleAttrs(x, y, width, height, className, title, attrs = "") {
  return `
    <rect
      class="${className}"
      x="${Number(x).toFixed(2)}"
      y="${y}"
      width="${Number(width).toFixed(2)}"
      height="${height}"
      rx="4"
      ${attrs}
    >
      <title>${esc(title)}</title>
    </rect>
  `;
}

function interactiveRectWithTitle(x, y, width, height, className, title, spanId) {
  return `
    <rect
      class="${className} span-clickable"
      x="${Number(x).toFixed(2)}"
      y="${y}"
      width="${Number(width).toFixed(2)}"
      height="${height}"
      rx="4"
      data-span-id="${esc(spanId)}"
      tabindex="0"
      focusable="true"
      role="button"
      aria-label="${esc(`${title}. Click for details.`)}"
    >
      <title>${esc(`${title}. Click for details.`)}</title>
    </rect>
  `;
}

function interactiveQueueRectWithTitle(x, y, width, height, className, title, itemId) {
  return `
    <rect
      class="${className} queue-clickable"
      x="${Number(x).toFixed(2)}"
      y="${y}"
      width="${Number(width).toFixed(2)}"
      height="${height}"
      rx="4"
      data-queue-item-id="${esc(itemId)}"
      tabindex="0"
      focusable="true"
      role="button"
      aria-label="${esc(`${title}. Click for details.`)}"
    >
      <title>${esc(`${title}. Click for details.`)}</title>
    </rect>
  `;
}

function interactiveQueueActivityRectWithTitle(x, y, width, height, className, title, activityId, attrs = "") {
  return `
    <rect
      class="${className} queue-activity-clickable"
      x="${Number(x).toFixed(2)}"
      y="${y}"
      width="${Number(width).toFixed(2)}"
      height="${height}"
      rx="4"
      data-queue-activity-id="${esc(activityId)}"
      tabindex="0"
      focusable="true"
      role="button"
      aria-label="${esc(`${title}. Click for queue workload details.`)}"
      ${attrs}
    >
      <title>${esc(`${title}. Click for queue workload details.`)}</title>
    </rect>
  `;
}

function points(points) {
  return points
    .map((point) => point.map((value) => value.toFixed(2)).join(","))
    .join(" ");
}

function markerGroup(marker, markerId, label, children, className = "") {
  return `
    <g
      class="marker marker-clickable ${className}"
      data-marker-id="${esc(markerId)}"
      tabindex="0"
      focusable="true"
      role="button"
      aria-label="${esc(label)}"
    >
      ${children}
      <title>${esc(label)}</title>
    </g>
  `;
}

function markerShape(marker, markerId, cx, cy, title) {
  const label = `${title}. Click for details.`;
  const fill = markerColor(marker.type);
  if (marker.type === "assistant") {
    return markerGroup(
      marker,
      markerId,
      label,
      `<rect x="${cx - 5}" y="${cy - 5}" width="10" height="10" rx="2" fill="${fill}"></rect>`,
      "marker-assistant",
    );
  }

  if (marker.type === "task") {
    return markerGroup(
      marker,
      markerId,
      label,
      `<polygon points="${points([[cx, cy - 7], [cx + 7, cy + 6], [cx - 7, cy + 6]])}" fill="${fill}"></polygon>`,
      "marker-task",
    );
  }

  if (marker.type === "goal") {
    return markerGroup(
      marker,
      markerId,
      label,
      `<polygon points="${points([[cx - 6, cy - 4], [cx, cy - 7], [cx + 6, cy - 4], [cx + 6, cy + 4], [cx, cy + 7], [cx - 6, cy + 4]])}" fill="${fill}"></polygon>`,
      "marker-goal",
    );
  }

  if (marker.type === "compact") {
    return markerGroup(
      marker,
      markerId,
      label,
      `
        <line x1="${cx}" y1="${cy - 16}" x2="${cx}" y2="${cy + 16}" class="marker-compact-tick"></line>
        <polygon points="${points([[cx, cy - 7], [cx + 6, cy], [cx, cy + 7], [cx - 6, cy]])}" fill="${fill}"></polygon>
      `,
      "marker-compact",
    );
  }

  if (marker.type === "abort") {
    return markerGroup(
      marker,
      markerId,
      label,
      `
        <line x1="${cx - 5}" y1="${cy - 5}" x2="${cx + 5}" y2="${cy + 5}" class="marker-abort-line"></line>
        <line x1="${cx + 5}" y1="${cy - 5}" x2="${cx - 5}" y2="${cy + 5}" class="marker-abort-line"></line>
      `,
      "marker-abort",
    );
  }

  if (marker.type === "app") {
    return markerGroup(
      marker,
      markerId,
      label,
      `
        <circle cx="${cx}" cy="${cy}" r="5.5" fill="${fill}"></circle>
        <circle cx="${cx}" cy="${cy}" r="2.1" fill="#ffffff"></circle>
      `,
      "marker-app",
    );
  }

  if (String(marker.type || "").startsWith("queue_")) {
    return markerGroup(
      marker,
      markerId,
      label,
      `
        <circle cx="${cx}" cy="${cy}" r="5" fill="${fill}"></circle>
        <circle cx="${cx}" cy="${cy}" r="1.8" fill="#ffffff"></circle>
      `,
      "marker-queue",
    );
  }

  return markerGroup(
    marker,
    markerId,
    label,
    `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${fill}"></circle>`,
    "marker-user",
  );
}

function renderSubagents(children, activeLeases) {
  if (!subagentsPanel || !subagentTable) return;
  if (!children.length) {
    subagentsPanel.hidden = true;
    return;
  }
  const activeByWorker = new Map();
  for (const item of activeLeases) {
    const key = item.leaseOwner || "unknown";
    activeByWorker.set(key, (activeByWorker.get(key) || 0) + 1);
  }
  subagentTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Agent</th>
          <th>Session</th>
          <th class="num">Live</th>
          <th class="num">Tools</th>
          <th class="num">Wait</th>
          <th class="num">Quiet</th>
        </tr>
      </thead>
      <tbody>
        ${children
          .map((child) => {
            const display = childSessionDisplay(child);
            return `
              <tr>
                <td><span class="${esc(display.tableClass)}">${esc(display.tableName)}</span></td>
                <td title="${esc(child.filePath)}">${esc(display.sessionLabel)}</td>
                <td class="num">${fmtDuration(child.elapsedMs)}</td>
                <td class="num">${fmtDuration(child.metrics.toolMs)}</td>
                <td class="num">${fmtDuration(child.metrics.waitMs)}</td>
                <td class="num">${fmtDuration(child.metrics.quietMs)}</td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
    ${
      activeByWorker.size
        ? `<p class="muted" style="margin-top:10px">Active leases now: ${[...activeByWorker.entries()]
            .map(([worker, count]) => `${esc(worker)} (${count})`)
            .join(", ")}</p>`
        : ""
    }
  `;
  subagentsPanel.hidden = false;
}

function renderQueues(queue) {
  if (!(queue.queues || []).length && !queue.itemRowsTotal && !(queue.items || []).length) {
    queuesPanel.hidden = true;
    return;
  }
  const totalItems = queue.itemRowsTotal || queue.stats?.total || (queue.items || []).length;
  const detailRows = queue.itemRowsLoaded || (queue.items || []).length;
  const timelineRows = queue.timelineRowsLoaded || 0;
  const hasCancelled = (queue.queues || []).some((q) => q.counts?.cancelled);
  queueTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Queue</th>
          <th>Namespace</th>
          <th class="num">Queued</th>
          <th class="num">Leased</th>
          <th class="num">Done</th>
          <th class="num">Failed</th>
          ${hasCancelled ? `<th class="num">Cancelled</th>` : ""}
        </tr>
      </thead>
      <tbody>
        ${(queue.queues || [])
          .map((q) => `
            <tr>
              <td title="${esc(q.name)}">${esc(queueDisplayName(q))}</td>
              <td title="${esc(q.namespace)}">${esc(shortNamespace(q.namespace))}</td>
              <td class="num">${q.counts.queued || 0}</td>
              <td class="num">${q.counts.leased || 0}</td>
              <td class="num">${q.counts.completed || 0}</td>
              <td class="num">${q.counts.failed || 0}</td>
              ${hasCancelled ? `<td class="num">${q.counts.cancelled || 0}</td>` : ""}
            </tr>
          `)
          .join("")}
      </tbody>
    </table>
    <p class="muted" style="margin-top:10px" title="${esc(queue.dbPath)}">
      ${fmtCount(totalItems)} total item rows counted from ${esc(queue.dbPath)}.
      ${fmtCount(detailRows)} detailed sample row${detailRows === 1 ? "" : "s"} loaded${queue.truncated ? " (sample capped)" : ""};
      ${fmtCount(timelineRows)} timeline row${timelineRows === 1 ? "" : "s"} aggregated${queue.timelineTruncated ? " (timeline capped)" : ""}.
    </p>
  `;
  queuesPanel.hidden = false;
}

function shortNamespace(namespace) {
  if (!namespace) return "";
  if (namespace.length <= 58) return namespace;
  const parts = namespace.split("/");
  return parts.length > 2 ? `${parts[0]}/.../${parts[parts.length - 1]}` : `${namespace.slice(0, 55)}...`;
}

function compactPath(value) {
  const text = String(value || "");
  if (text.length <= 48) return text;
  const parts = text.split("/");
  if (parts.length < 3) return `${text.slice(0, 45)}...`;
  const tail = parts.slice(-3).join("/");
  return tail.length <= 48 ? tail : `...${tail.slice(-45)}`;
}

function markerTargetFromEvent(event) {
  const markerEl = event.target.closest?.(".marker-clickable");
  if (!markerEl || !timelineWrap.contains(markerEl)) return null;
  const marker = markerLookup.get(markerEl.dataset.markerId);
  return marker ? { markerEl, marker } : null;
}

function spanTargetFromEvent(event) {
  const spanEl = event.target.closest?.(".span-clickable");
  if (!spanEl || !timelineWrap.contains(spanEl)) return null;
  const span = spanLookup.get(spanEl.dataset.spanId);
  return span ? { spanEl, span } : null;
}

function laneTargetFromEvent(event) {
  const laneEl = event.target.closest?.(".lane-clickable");
  if (!laneEl || !timelineWrap.contains(laneEl)) return null;
  const lane = laneLookup.get(laneEl.dataset.laneId);
  return lane?.session ? { laneEl, lane } : null;
}

function queueItemTargetFromEvent(event) {
  const itemEl = event.target.closest?.(".queue-clickable");
  if (!itemEl || !queueTimelineWrap?.contains(itemEl)) return null;
  const item = queueItemLookup.get(itemEl.dataset.queueItemId);
  return item ? { itemEl, item } : null;
}

function queueActivityTargetFromEvent(event) {
  const activityEl = event.target.closest?.(".queue-activity-clickable");
  if (!activityEl || !queueTimelineWrap?.contains(activityEl)) return null;
  const activity = queueActivityLookup.get(activityEl.dataset.queueActivityId);
  return activity ? { activityEl, activity } : null;
}

function queueLaneTargetFromEvent(event) {
  const laneEl = event.target.closest?.(".queue-lane-clickable");
  if (!laneEl || !queueTimelineWrap?.contains(laneEl)) return null;
  const activity = queueLaneLookup.get(laneEl.dataset.queueLaneId);
  return activity ? { laneEl, activity } : null;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitSessionId(input.value);
});

sessionPickerToggle?.addEventListener("click", () => {
  if (!sessionPickerMenu?.hidden) {
    closeSessionPicker();
    return;
  }
  fetchSessionSuggestions("");
});

input?.addEventListener("input", scheduleSessionSuggestionSearch);

input?.addEventListener("keydown", (event) => {
  const isOpen = !sessionPickerMenu?.hidden;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!isOpen) {
      fetchSessionSuggestions(input.value.trim());
      return;
    }
    setHighlightedSessionSuggestion(
      Math.min(sessionSuggestions.length - 1, highlightedSessionSuggestion + 1),
    );
  } else if (event.key === "ArrowUp") {
    if (!isOpen) return;
    event.preventDefault();
    setHighlightedSessionSuggestion(Math.max(0, highlightedSessionSuggestion - 1));
  } else if (event.key === "Enter" && isOpen && highlightedSessionSuggestion >= 0) {
    event.preventDefault();
    selectSessionSuggestion(highlightedSessionSuggestion);
  } else if (event.key === "Escape" && isOpen) {
    event.preventDefault();
    closeSessionPicker();
  }
});

sessionPickerMenu?.addEventListener("pointermove", (event) => {
  const option = event.target.closest?.("[data-session-index]");
  if (!option || !sessionPickerMenu.contains(option)) return;
  setHighlightedSessionSuggestion(Number(option.dataset.sessionIndex));
});

sessionPickerMenu?.addEventListener("pointerdown", (event) => {
  const option = event.target.closest?.("[data-session-index]");
  if (!option || !sessionPickerMenu.contains(option)) return;
  event.preventDefault();
  selectSessionSuggestion(Number(option.dataset.sessionIndex));
});

document.addEventListener("pointerdown", (event) => {
  if (sessionPicker?.contains(event.target)) return;
  closeSessionPicker();
});

timelineTab?.addEventListener("click", () => setActiveView("timeline"));
queuesTab?.addEventListener("click", () => setActiveView("queues"));
for (const checkbox of [filterEvents, filterTools, filterWaits, filterSpawns]) {
  checkbox?.addEventListener("change", () => {
    if (!currentData) return;
    renderTimeline(currentData);
    if (activeView === "queues") renderQueueTimeline(currentData);
  });
}
exportSessionButton?.addEventListener("click", exportCurrentSession);
refreshSessionButton?.addEventListener("click", refreshCurrentSession);
queueRefreshButton?.addEventListener("click", () => refreshQueuesOnly());
queueAutoRefresh?.addEventListener("change", () => setQueueAutoRefresh(queueAutoRefresh.checked));

timelineZoomIn.addEventListener("click", () => zoomTimeline(0.5));
timelineZoomOut.addEventListener("click", () => zoomTimeline(2));
timelinePanLeft.addEventListener("click", () => panTimeline(-0.5));
timelinePanRight.addEventListener("click", () => panTimeline(0.5));
timelineReset.addEventListener("click", resetTimeline);
queueTimelineZoomIn?.addEventListener("click", () => zoomQueueTimeline(0.5));
queueTimelineZoomOut?.addEventListener("click", () => zoomQueueTimeline(2));
queueTimelinePanLeft?.addEventListener("click", () => panQueueTimeline(-0.5));
queueTimelinePanRight?.addEventListener("click", () => panQueueTimeline(0.5));
queueTimelineReset?.addEventListener("click", resetQueueTimeline);
timelineNow?.addEventListener("click", () => {
  if (!focusActiveSpan() && currentData) resetTimeline();
});
followActive?.addEventListener("change", () => {
  if (followActive.checked) focusActiveSpan();
});

timelineWrap.addEventListener(
  "wheel",
  (event) => {
    if (!currentData || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    zoomTimeline(event.deltaY > 0 ? 1.25 : 0.8);
  },
  { passive: false },
);
timelineWrap.addEventListener("pointerdown", startTimelineDrag);
timelineWrap.addEventListener("pointermove", moveTimelineDrag);
timelineWrap.addEventListener("pointerup", finishTimelineDrag);
timelineWrap.addEventListener("pointercancel", () => {
  clearDragSelection();
  if (currentData) updateTimelineControls(currentData);
});
timelineWrap.addEventListener("click", (event) => {
  const laneTarget = laneTargetFromEvent(event);
  if (laneTarget) {
    event.stopPropagation();
    openSessionPopover(laneTarget.lane.session, laneTarget.laneEl);
    return;
  }
  const markerTarget = markerTargetFromEvent(event);
  if (markerTarget) {
    event.stopPropagation();
    openMarkerPopover(markerTarget.marker, markerTarget.markerEl);
    return;
  }
  const spanTarget = spanTargetFromEvent(event);
  if (!spanTarget) return;
  event.stopPropagation();
  openSpanPopover(spanTarget.span, spanTarget.spanEl);
});
timelineWrap.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
  const laneTarget = laneTargetFromEvent(event);
  if (laneTarget) {
    event.preventDefault();
    openSessionPopover(laneTarget.lane.session, laneTarget.laneEl);
    return;
  }
  const markerTarget = markerTargetFromEvent(event);
  if (markerTarget) {
    event.preventDefault();
    openMarkerPopover(markerTarget.marker, markerTarget.markerEl);
    return;
  }
  const spanTarget = spanTargetFromEvent(event);
  if (!spanTarget) return;
  event.preventDefault();
  openSpanPopover(spanTarget.span, spanTarget.spanEl);
});

queueTimelineWrap?.addEventListener("click", (event) => {
  const laneTarget = queueLaneTargetFromEvent(event);
  if (laneTarget) {
    event.stopPropagation();
    openQueueActivityPopover(laneTarget.activity, laneTarget.laneEl);
    return;
  }
  const activityTarget = queueActivityTargetFromEvent(event);
  if (activityTarget) {
    event.stopPropagation();
    openQueueActivityPopover(activityTarget.activity, activityTarget.activityEl);
    return;
  }
  const itemTarget = queueItemTargetFromEvent(event);
  if (!itemTarget) return;
  event.stopPropagation();
  openQueueItemPopover(itemTarget.item, itemTarget.itemEl);
});
queueTimelineWrap?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
  const laneTarget = queueLaneTargetFromEvent(event);
  if (laneTarget) {
    event.preventDefault();
    openQueueActivityPopover(laneTarget.activity, laneTarget.laneEl);
    return;
  }
  const activityTarget = queueActivityTargetFromEvent(event);
  if (activityTarget) {
    event.preventDefault();
    openQueueActivityPopover(activityTarget.activity, activityTarget.activityEl);
    return;
  }
  const itemTarget = queueItemTargetFromEvent(event);
  if (!itemTarget) return;
  event.preventDefault();
  openQueueItemPopover(itemTarget.item, itemTarget.itemEl);
});
queueTimelineWrap?.addEventListener("pointerdown", startQueueTimelineDrag);
queueTimelineWrap?.addEventListener("pointermove", moveQueueTimelineDrag);
queueTimelineWrap?.addEventListener("pointerup", finishQueueTimelineDrag);
queueTimelineWrap?.addEventListener("pointercancel", () => {
  clearQueueTimelineDrag();
  if (currentData) updateQueueTimelineControls(currentData);
});

timelineMinimap?.addEventListener("pointerdown", startMinimapDrag);
timelineMinimap?.addEventListener("pointermove", moveMinimapDrag);
timelineMinimap?.addEventListener("pointerup", finishMinimapDrag);
timelineMinimap?.addEventListener("pointercancel", () => {
  minimapDrag = null;
  setMinimapDragClasses("");
  if (currentData) renderTimelineMinimap(currentData);
});

markerPopoverClose?.addEventListener("click", closeMarkerPopover);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeMarkerPopover();
  closeSessionPicker();
});

window.addEventListener("resize", () => {
  if (!currentData) return;
  renderTimeline(currentData);
  renderQueueProgress(currentData.queue || {});
  if (activeView === "queues") renderQueueTimeline(currentData);
  applyActiveView();
});

const initialSession = new URL(window.location.href).searchParams.get("session");
if (initialSession) {
  input.value = initialSession;
  loadSession(initialSession).catch((err) => updateStatus(err.message, ""));
}
