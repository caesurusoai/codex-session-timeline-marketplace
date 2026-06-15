"use strict";

const form = document.getElementById("session-form");
const sessionPicker = document.getElementById("session-picker");
const input = document.getElementById("session-id");
const sessionPickerToggle = document.getElementById("session-picker-toggle");
const sessionPickerMenu = document.getElementById("session-picker-menu");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const viewTabs = document.getElementById("view-tabs");
const timelineTab = document.getElementById("timeline-tab");
const queuesTab = document.getElementById("queues-tab");
const queueTabCount = document.getElementById("queue-tab-count");
const queueProgressCard = document.getElementById("queue-progress-card");
const queueProgress = document.getElementById("queue-progress");
const queueRefreshButton = document.getElementById("queue-refresh");
const queueAutoRefresh = document.getElementById("queue-auto-refresh");
const queueRefreshStatus = document.getElementById("queue-refresh-status");
const timelineCard = document.getElementById("timeline-card");
const timelineWrap = document.getElementById("timeline-wrap");
const timelineCaption = document.getElementById("timeline-caption");
const queueTimelineCard = document.getElementById("queue-timeline-card");
const queueTimelineWrap = document.getElementById("queue-timeline-wrap");
const queueTimelineCaption = document.getElementById("queue-timeline-caption");
const timelineReadout = document.getElementById("timeline-readout");
const timelineZoomIn = document.getElementById("timeline-zoom-in");
const timelineZoomOut = document.getElementById("timeline-zoom-out");
const timelinePanLeft = document.getElementById("timeline-pan-left");
const timelinePanRight = document.getElementById("timeline-pan-right");
const timelineReset = document.getElementById("timeline-reset");
const loadFullDetailsButton = document.getElementById("load-full-details");
const loadAllEventsButton = document.getElementById("load-all-events");
const subagentsPanel = document.getElementById("subagents");
const subagentTable = document.getElementById("subagent-table");
const queuesPanel = document.getElementById("queues");
const queueTable = document.getElementById("queue-table");
const warningsEl = document.getElementById("warnings");
const markerPopover = document.getElementById("marker-popover");
const markerPopoverCard = document.getElementById("marker-popover-card");
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
let fullDetailsLoading = false;
let allEventsLoading = false;
let timelineView = null;
let timelineDrag = null;
let markerLookup = new Map();
let spanLookup = new Map();
let laneLookup = new Map();
let queueItemLookup = new Map();
let sessionSuggestions = [];
let highlightedSessionSuggestion = -1;
let sessionSuggestionTimer = null;
let sessionSuggestionRequest = 0;

const MIN_TIMELINE_WINDOW_MS = 30 * 1000;
const DRAG_ZOOM_MIN_PX = 8;

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

function agentJobItemId(session) {
  return promptField(firstMarkerDetail(session, "user"), "Item ID");
}

function agentJobDisplayName(session) {
  const itemId = agentJobItemId(session);
  if (itemId) return itemId;
  if (session.meta?.agentNickname) return session.meta.agentNickname;
  if (session.title && session.title !== session.id) return session.title;
  const job = agentJobId(session);
  if (job) return `${job.slice(0, 8)} worker`;
  return session.id.slice(0, 13);
}

function agentJobSessionLabel(session) {
  const itemId = agentJobItemId(session);
  const job = agentJobId(session);
  if (itemId && job) return `${itemId} (${job})`;
  return itemId || job || session.id;
}

function stripUuidPrefix(value) {
  return String(value || "").replace(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[-_:]*/i,
    "",
  );
}

function humanizeWorkerSlug(value) {
  return String(value || "")
    .replace(/^deep[-_]+/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function workerNumberFromId(workerId) {
  const match = String(workerId || "").match(/(?:^|[-_])worker[-_]?(\d+)$/i);
  return match ? match[1] : "";
}

function workerRoleFromSource(source, fallback = "") {
  const workerId = source?.worker_id || fallback || "";
  const candidates = [
    source?.job_id,
    ...(Array.isArray(source?.queues) ? source.queues : []),
    workerId.replace(/(?:^|[-_])worker[-_]?\d+$/i, ""),
  ];

  for (const candidate of candidates) {
    const cleaned = stripUuidPrefix(candidate);
    const roleMatch = cleaned.match(
      /(?:^|[-_])(deep[-_]+file[-_]+review|deep[-_]+threat[-_]+model|file[-_]+review|threat[-_]+model|cvss[-_]+scoring|finding[-_]+discovery|validation|rerank|triage)(?=$|[-_])/i,
    );
    const role = humanizeWorkerSlug(roleMatch ? roleMatch[1] : cleaned);
    if (role && !/^[0-9a-f-]{8,}$/i.test(role)) return role;
  }

  return "";
}

function workerDisplayName(source, fallback = "") {
  const workerId = source?.worker_id || fallback || "";
  const number = workerNumberFromId(workerId);
  const role = workerRoleFromSource(source, fallback);
  if (role && number) return `${role} #${number}`;
  if (role) return role;
  if (number) return `worker #${number}`;
  return stripUuidPrefix(workerId) || fallback;
}

function childSessionDisplay(session) {
  if (isQueueWorkerSession(session)) {
    const source = session.meta?.source?.queue_worker || {};
    const name = workerDisplayName(source, session.meta?.agentNickname || session.title || session.id.slice(0, 13));
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
    const name = workerDisplayName(source, session.meta?.agentNickname || session.title || session.id.slice(0, 13));
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
    const name = agentJobDisplayName(session);
    return {
      lanePrefix: "agent job",
      name,
      tableName: "agent job",
      tableClass: "pill pill-agent-job",
      sessionLabel: agentJobSessionLabel(session),
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
    const loaded = source.event_rows_loaded ?? source.event_rows;
    const omitted = source.event_rows_omitted || 0;
    const rowWindow = source.event_rows_window === "latest" ? "latest" : "all";
    lines.push(
      `Launcher event rows parsed: ${loaded}/${source.event_rows}${
        source.event_rows_truncated ? ` (${rowWindow}; ${omitted} older omitted)` : ""
      }`,
    );
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
  const activityKind =
    newest.type === "wait" ? "wait" : newest.type === "spawn" ? "spawn" : "tool";
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

function apiQueryString(extra = {}) {
  const params = new URLSearchParams();
  const remote = currentRemote();
  const codexHome = currentCodexHome();
  if (remote) params.set("remote", remote);
  if (codexHome && !remote) params.set("codex_home", codexHome);
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null || value === false || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString() ? `?${params.toString()}` : "";
}

function updateFullDetailsButton() {
  if (!loadFullDetailsButton) return;
  if (!currentData) {
    loadFullDetailsButton.hidden = true;
    loadFullDetailsButton.disabled = true;
    return;
  }
  loadFullDetailsButton.hidden = false;
  if (fullDetailsLoading) {
    loadFullDetailsButton.disabled = true;
    loadFullDetailsButton.textContent = "Loading all details...";
    return;
  }
  const full = currentData.detailMode === "full" || currentData.detailsComplete;
  loadFullDetailsButton.disabled = full;
  loadFullDetailsButton.textContent = full ? "All details loaded" : "Load all details";
}

function launcherEventSummary(data) {
  const sources = (data?.appThreads || [])
    .map((thread) => thread?.meta?.source?.app_server)
    .filter(Boolean);
  const total = sources.reduce((sum, source) => sum + Number(source.event_rows || 0), 0);
  const loaded = sources.reduce(
    (sum, source) => sum + Number(source.event_rows_loaded ?? source.event_rows ?? 0),
    0,
  );
  const truncated = sources.some((source) => source.event_rows_truncated);
  return { total, loaded, truncated };
}

function updateAllEventsButton() {
  if (!loadAllEventsButton) return;
  if (!currentData) {
    loadAllEventsButton.hidden = true;
    loadAllEventsButton.disabled = true;
    return;
  }
  const summary = launcherEventSummary(currentData);
  loadAllEventsButton.hidden = !summary.total;
  if (loadAllEventsButton.hidden) return;
  if (allEventsLoading) {
    loadAllEventsButton.disabled = true;
    loadAllEventsButton.textContent = "Loading all events...";
    return;
  }
  const allLoaded = currentData.launcherEventsMode === "all" || !summary.truncated;
  loadAllEventsButton.disabled = allLoaded;
  loadAllEventsButton.textContent = allLoaded
    ? "All events loaded"
    : `Load all events (${fmtCount(summary.loaded)}/${fmtCount(summary.total)})`;
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

function selectSessionSuggestion(index) {
  const row = sessionSuggestions[index];
  if (!row?.id) return;
  submitSessionId(row.id);
}

async function loadSession(sessionId) {
  const remote = currentRemote();
  const codexHome = currentCodexHome();
  timelineView = null;
  fullDetailsLoading = false;
  allEventsLoading = false;
  stopQueueAutoRefresh();
  if (queueAutoRefresh) queueAutoRefresh.checked = false;
  setQueueRefreshStatus("Not refreshed yet");
  currentData = null;
  updateFullDetailsButton();
  updateAllEventsButton();
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

async function loadFullDetails() {
  if (!currentData?.session?.id || fullDetailsLoading) return;
  const sessionId = currentData.session.id;
  const previousView = activeView;
  const previousTimelineView = timelineView ? { ...timelineView } : null;
  fullDetailsLoading = true;
  updateFullDetailsButton();
  updateStatus(`Loading all details for ${sessionId}...`);
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}${apiQueryString({ full: 1 })}`);
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Unable to load full details.");
    currentData = data;
    timelineView = previousTimelineView;
    render(data);
    setActiveView(previousView);
  } catch (err) {
    updateStatus(err.message || "Unable to load full details.", "");
  } finally {
    fullDetailsLoading = false;
    updateFullDetailsButton();
  }
}

async function loadAllEvents() {
  if (!currentData?.session?.id || allEventsLoading) return;
  const sessionId = currentData.session.id;
  const previousView = activeView;
  const previousTimelineView = timelineView ? { ...timelineView } : null;
  const full = currentData.detailMode === "full" || currentData.detailsComplete;
  allEventsLoading = true;
  updateAllEventsButton();
  updateStatus(`Loading all launcher events for ${sessionId}...`);
  try {
    const res = await fetch(
      `/api/session/${encodeURIComponent(sessionId)}${apiQueryString({ full: full ? 1 : "", events: "all" })}`,
    );
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Unable to load all launcher events.");
    currentData = data;
    timelineView = previousTimelineView;
    render(data);
    setActiveView(previousView);
  } catch (err) {
    updateStatus(err.message || "Unable to load all launcher events.", "");
  } finally {
    allEventsLoading = false;
    updateAllEventsButton();
  }
}

function render(data) {
  const session = data.session;
  const queue = data.queue || {};
  const appThreads = data.appThreads || [];
  const queueWorkers = data.queueWorkers || queue.workers || [];
  const subagents = data.subagents || [];
  const childRows = [...subagents, ...appThreads];
  const totalElapsed = data.domain.end - data.domain.start;
  const allWaitMs =
    session.metrics.waitMs +
    childRows.reduce((sum, child) => sum + child.metrics.waitMs, 0);
  const remoteLabel = data.source?.type === "remote" ? ` | remote: ${data.source.remote}` : "";
  const queueWorkerCount = queueWorkers.length;

  updateStatus(
    `${session.title || "Untitled session"} | ${session.id}${remoteLabel} | ${fmtDateTime(data.domain.start)} to ${fmtDateTime(data.domain.end)}`,
  );

  const currentActivity = currentActivityMetric(data);
  summaryEl.innerHTML = [
    metric("Total span", fmtDuration(totalElapsed), session.meta.cwd || session.filePath),
    metric("Parent wait", fmtDuration(session.metrics.waitMs), `${pct(session.metrics.waitMs, session.elapsedMs)} of parent session`),
    metric("All explicit wait", fmtDuration(allWaitMs), "queue_wait_for_event and wait-like tools"),
    currentActivity,
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
  updateTimelineControls(data);
  updateFullDetailsButton();
  updateAllEventsButton();
  timelineCard.hidden = false;

  renderQueues(queue);
  applyActiveView();

  if (data.warnings && data.warnings.length) {
    warningsEl.innerHTML = `<strong>Notes</strong><br>${data.warnings.map(esc).join("<br>")}`;
    warningsEl.hidden = false;
  }
}

function hasQueueData(queue) {
  return Boolean(
    (queue?.stats?.total || 0) ||
      (queue?.queues || []).length ||
      (queue?.itemRowsTotal || 0) ||
      (queue?.unlinkedQueues || []).length,
  );
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

function queueDisplayName(queue) {
  const name = queue?.name || "";
  return name.length > 78 ? `${name.slice(0, 34)}...${name.slice(-34)}` : name;
}

function queueActiveItems(queue) {
  return Number(queue?.counts?.queued || 0) + Number(queue?.counts?.leased || 0);
}

function queueSortForVisibility(a, b) {
  const activeDiff = queueActiveItems(b) - queueActiveItems(a);
  if (activeDiff) return activeDiff;
  const statusRank = { running: 0, pending: 1, completed: 2, failed: 3, cancelled: 4 };
  const statusDiff = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
  if (statusDiff) return statusDiff;
  const updatedDiff = (Date.parse(b.updatedAt || b.lastActivityAt || "") || 0) -
    (Date.parse(a.updatedAt || a.lastActivityAt || "") || 0);
  if (updatedDiff) return updatedDiff;
  return String(a.name || "").localeCompare(String(b.name || ""));
}

function fmtQueueDate(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? fmtDateTime(ms) : "";
}

function queueSourceLabel(queue) {
  return queue.source === "codex-security" ? "Codex Security DB" : "Queue Service";
}

function queueLinkLabel(queue) {
  if (queue.linkedToSession) return "linked to this session";
  if (queue.linkStatus === "other-session") return "linked to other session";
  if (queue.linkStatus === "unlinked") return queue.heartbeatStale ? "unlinked / stale heartbeat" : "unlinked";
  return "";
}

function queueBadge(text, className = "") {
  return text ? `<span class="queue-badge ${className}">${esc(text)}</span>` : "";
}

function queueProgressRow(queue, options = {}) {
  const counts = queue.counts || {};
  const total = Number(counts.total || 0);
  const active = queueActiveItems(queue);
  const completed = Number(counts.completed || 0);
  const donePct = total ? Math.round((completed / total) * 100) : 0;
  const diagnostic = Boolean(options.diagnostic || queue.diagnosticReason);
  const rowClass = `queue-row ${diagnostic ? "queue-row-diagnostic" : ""}`.trim();
  const updatedAt = fmtQueueDate(queue.updatedAt || queue.lastActivityAt);
  const completedAt = fmtQueueDate(queue.lastCompletedAt);
  const heartbeatAt = fmtQueueDate(queue.parentHeartbeatAt);
  const linkLabel = queueLinkLabel(queue);
  const badges = [
    queueBadge(queue.status ? `job ${queue.status}` : "", `queue-badge-status status-${esc(queue.status || "unknown")}`),
    queueBadge(queueSourceLabel(queue), "queue-badge-source"),
    queueBadge(linkLabel, queue.linkedToSession ? "queue-badge-linked" : "queue-badge-warning"),
    queue.heartbeatStale ? queueBadge("stale heartbeat", "queue-badge-warning") : "",
  ].join("");
  return `
    <article class="${rowClass}">
      <div class="queue-row-main">
        <div>
          <h3 title="${esc(queue.name || "")}">${esc(queueDisplayName(queue))}</h3>
          <div class="queue-badges">${badges}</div>
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
      <div class="queue-detail-grid">
        <span title="${esc(queue.namespace || "")}"><b>Job</b> ${esc(shortNamespace(queue.namespace || queue.name || ""))}</span>
        ${queue.workerCount != null ? `<span><b>Workers</b> ${fmtCount(queue.workerCount)}</span>` : ""}
        ${queue.sampleRowsLoaded != null ? `<span><b>Samples</b> ${fmtCount(queue.sampleRowsLoaded)}</span>` : ""}
        ${updatedAt ? `<span><b>Updated</b> ${esc(updatedAt)}</span>` : ""}
        ${completedAt ? `<span><b>Completed</b> ${esc(completedAt)}</span>` : ""}
        ${queue.parentThreadId ? `<span title="${esc(queue.parentThreadId)}"><b>Parent</b> ${esc(queue.parentThreadId)}</span>` : ""}
        ${heartbeatAt ? `<span><b>Heartbeat</b> ${esc(heartbeatAt)}</span>` : ""}
        ${queue.diagnosticReason ? `<span><b>Diagnostic</b> ${esc(queue.diagnosticReason)}</span>` : ""}
        ${queue.dbPath ? `<span class="queue-db-path" title="${esc(queue.dbPath)}"><b>DB</b> ${esc(compactPath(queue.dbPath))}</span>` : ""}
      </div>
    </article>
  `;
}

function queueSection(title, hint, rows, options = {}) {
  return `
    <section class="queue-section ${options.className || ""}">
      <div class="queue-section-heading">
        <div>
          <h3>${esc(title)}</h3>
          <p class="muted">${esc(hint || "")}</p>
        </div>
        <span class="queue-section-count">${fmtCount(rows.length)} job${rows.length === 1 ? "" : "s"}</span>
      </div>
      <div class="queue-list">
        ${rows.length ? rows.map((queue) => queueProgressRow(queue, options)).join("") : `<div class="queue-empty"><h3>No queue jobs</h3><p class="muted">No rows matched this section.</p></div>`}
      </div>
    </section>
  `;
}

function renderQueueProgress(queue) {
  if (!queueProgress) return;
  const stats = queue?.stats || {};
  const total = Number(queue?.itemRowsTotal || stats.total || 0);
  const unlinkedQueues = (queue?.unlinkedQueues || []).slice().sort(queueSortForVisibility);
  const unlinkedTotal = unlinkedQueues.reduce((sum, item) => sum + Number(item.counts?.total || 0), 0);
  const queues = (queue?.queues || [])
    .slice()
    .sort(queueSortForVisibility);
  if (queueTabCount) queueTabCount.textContent = fmtCount((total || stats.total || 0) + unlinkedTotal || queues.length + unlinkedQueues.length);

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
      ${unlinkedQueues.length ? queueProgressSummaryCard("Unlinked", fmtCount(unlinkedTotal), `${fmtCount(unlinkedQueues.length)} active/stale diagnostic queue${unlinkedQueues.length === 1 ? "" : "s"}`, "diagnostic") : ""}
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
    ${queueSection(
      "Linked Queues",
      "Queue jobs with an ownership link to this Codex session. These drive the totals above.",
      queues,
    )}
    ${
      unlinkedQueues.length
        ? queueSection(
            "Unlinked Queue Diagnostics",
            "Active or stale queue jobs found in the same scan root but not linked to this session by parent_thread_id.",
            unlinkedQueues,
            { diagnostic: true, className: "queue-section-diagnostic" },
          )
        : ""
    }
    <p class="muted queue-footnote" title="${esc(dbPaths.join("\n"))}">
      ${fmtCount(queue.itemRowsLoaded || 0)} sampled item row${(queue.itemRowsLoaded || 0) === 1 ? "" : "s"} loaded from ${fmtCount(dbPaths.length)} DB${dbPaths.length === 1 ? "" : "s"}.
      ${queue.truncated ? "Details are sample-capped; totals come from SQL counts." : "Totals and samples are fully loaded for the discovered queue rows."}
      ${unlinkedQueues.length ? ` ${fmtCount(unlinkedTotal)} diagnostic item${unlinkedTotal === 1 ? "" : "s"} are shown separately and not included in linked-session totals.` : ""}
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
  if (!markerPopover) return;
  markerPopover.hidden = true;
}

function openDetailPopover(detail, target) {
  if (!markerPopover || !markerPopoverCard || !detail) return;

  markerPopoverKicker.textContent = detail.kicker || "";
  markerPopoverTitle.textContent = detail.title || "Detail";
  markerPopoverMeta.textContent = (detail.meta || []).filter(Boolean).join(" | ");
  markerPopoverBody.textContent = detail.body || "No detail payload was captured for this item.";

  markerPopover.hidden = false;
  placeMarkerPopover(target);
  markerPopoverClose?.focus({ preventScroll: true });
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
  openDetailPopover(
    {
      kicker: running ? "running" : span.type || "span",
      title: running ? `Running ${spanKindLabel(span.type).toLowerCase()}` : spanKindLabel(span.type),
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

function renderTimeline(data) {
  closeMarkerPopover();
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
  for (const child of data.subagents || []) {
    const display = childSessionDisplay(child);
    const labelKind =
      display.lanePrefix === "app worker"
        ? "app-worker"
        : display.lanePrefix === "queue worker"
          ? "queue-worker"
          : display.lanePrefix === "agent job"
            ? "agent-job"
            : "";
    lanes.push({
      label: `${display.lanePrefix}: ${display.name}`,
      labelKind,
      kind: "session",
      session: child,
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
      const labelClass = lane.labelKind === "app-worker" ? "lane-label-compact" : "";
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
        ${laneLabelText(label, laneId, y + 19, labelClass, lane.label)}
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
          .sort((a, b) => spanPaintRank(a.type) - spanPaintRank(b.type) || a.start - b.start);
        for (const span of visibleSpans) {
          const spanRange = clipRange(span.start, span.end, domainStart, domainEnd);
          const spanId = `span-${spanCounter++}`;
          const running = span.active || span.status === "running";
          spanLookup.set(spanId, {
            ...span,
            lane: lane.label,
            sessionId: session.id,
            sessionTitle: session.title || "",
          });
          const spanTitle = `${running ? "Running " : ""}${spanKindLabel(span.type)}: ${span.label}, ${fmtDuration(span.durationMs)}${running ? " so far" : ""}${span.exitCode == null ? "" : `, exit ${span.exitCode}`}`;
          content += interactiveRectWithTitle(
            x(spanRange.start),
            y + 7,
            Math.max(2, x(spanRange.end) - x(spanRange.start)),
            14,
            `${spanClass(span.type)}${running ? " span-running" : ""}`,
            spanTitle,
            spanId,
          );
        }
        const visibleMarkers = (session.markers || [])
          .filter((marker) => marker.ts >= domainStart && marker.ts <= domainEnd)
          .sort((a, b) => markerPaintRank(a.type) - markerPaintRank(b.type) || a.ts - b.ts);
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
  updateTimelineControls(data);
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

function renderQueueTimeline(data) {
  if (!queueTimelineCard || !queueTimelineWrap || !queueTimelineCaption) return;
  queueItemLookup = new Map();
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
  const view = queueTimelineFullDomain(data);
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
    if (track) {
      lanes.push({
        label: `throughput: ${q.name}`,
        kind: "queueActivity",
        queue: q,
        track,
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
    `Each throughput row is an aggregate heatmap from ${fmtCount(timelineRowsLoaded)}${queue.timelineTruncated ? "+" : ""} sampled item lifetime${timelineRowsLoaded === 1 ? "" : "s"} across ${fmtCount(tracks.length || queueByKey.size)} queue${(tracks.length || queueByKey.size) === 1 ? "" : "s"}.`,
    visibleSamples.length > itemLimit
      ? `Showing ${fmtCount(itemLimit)} of ${fmtCount(visibleSamples.length)} active/problem item rows.`
      : visibleSamples.length
        ? `Showing ${fmtCount(visibleSamples.length)} active/problem item row${visibleSamples.length === 1 ? "" : "s"}.`
        : `Completed item samples are hidden; totals for all ${fmtCount(totalItems)} items are in Queue Progress above.`,
  ].join(" ");

  const height = top + axisH + lanes.length * laneH + 18;
  let queueItemCounter = 0;
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
      let content = `
        ${laneLabelText(label, "", y + 19, lane.labelKind ? "lane-label-compact" : "", lane.label)}
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
          content += rectWithTitleAttrs(
            x(binRange.start),
            y + 8,
            Math.max(1, x(binRange.end) - x(binRange.start)),
            12,
            `${spanClass(status)} queue-density-bin`,
            queueBinTitle(track.name, bin),
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
    >
      ${tickEls}
      ${laneEls}
    </svg>
  `;
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
  const isCompactWorker =
    lane.labelKind === "app-worker" ||
    lane.labelKind === "queue-worker" ||
    lane.labelKind === "agent-job";
  const max = isCompactWorker
    ? (left >= 300 ? 48 : 40)
    : (left >= 300 ? 52 : 44);
  const label = lane.label || "";

  if (!isCompactWorker) return ellipsizeEnd(label, max);

  const prefixMatch = label.match(/^((?:(?:app|queue) (?:worker|thread)|agent job):\s*)(.+)$/);
  if (!prefixMatch) return ellipsizeMiddle(label, max);
  const [, prefix, name] = prefixMatch;
  return `${prefix}${ellipsizeMiddle(name, Math.max(12, max - prefix.length))}`;
}

function laneLabelText(label, laneId, y, extraClass = "", fullLabel = label) {
  const className = ["lane-label", extraClass].filter(Boolean).join(" ");
  if (!laneId) {
    return `<text class="${esc(className)}" x="10" y="${y}">${esc(label)}<title>${esc(fullLabel)}</title></text>`;
  }

  return `
    <text
      class="${esc(`${className} lane-clickable`)}"
      x="10"
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
  const linkedRows = queue.queues || [];
  const diagnosticRows = queue.unlinkedQueues || [];
  const rows = [...linkedRows, ...diagnosticRows].sort(queueSortForVisibility);
  if (!rows.length && !queue.itemRowsTotal && !(queue.items || []).length) {
    queuesPanel.hidden = true;
    return;
  }
  const totalItems = queue.itemRowsTotal || queue.stats?.total || (queue.items || []).length;
  const detailRows = queue.itemRowsLoaded || (queue.items || []).length;
  const timelineRows = queue.timelineRowsLoaded || 0;
  const diagnosticTotal = diagnosticRows.reduce((sum, item) => sum + Number(item.counts?.total || 0), 0);
  const hasCancelled = rows.some((q) => q.counts?.cancelled);
  queueTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Queue</th>
          <th>Status</th>
          <th>Link</th>
          <th>Source</th>
          <th class="num">Queued</th>
          <th class="num">Leased</th>
          <th class="num">Done</th>
          <th class="num">Failed</th>
          ${hasCancelled ? `<th class="num">Cancelled</th>` : ""}
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((q) => `
            <tr class="${q.diagnosticReason ? "queue-table-diagnostic" : ""}">
              <td title="${esc([q.namespace, q.dbPath].filter(Boolean).join("\n"))}">${esc(q.name)}</td>
              <td>${esc(q.status || "")}</td>
              <td>${esc(queueLinkLabel(q) || "")}</td>
              <td>${esc(queueSourceLabel(q))}</td>
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
      ${diagnosticRows.length ? `${fmtCount(diagnosticTotal)} diagnostic item${diagnosticTotal === 1 ? "" : "s"} shown separately.` : ""}
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
queueRefreshButton?.addEventListener("click", () => refreshQueuesOnly());
queueAutoRefresh?.addEventListener("change", () => setQueueAutoRefresh(queueAutoRefresh.checked));

timelineZoomIn.addEventListener("click", () => zoomTimeline(0.5));
timelineZoomOut.addEventListener("click", () => zoomTimeline(2));
timelinePanLeft.addEventListener("click", () => panTimeline(-0.5));
timelinePanRight.addEventListener("click", () => panTimeline(0.5));
timelineReset.addEventListener("click", resetTimeline);
loadFullDetailsButton?.addEventListener("click", loadFullDetails);
loadAllEventsButton?.addEventListener("click", loadAllEvents);

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
  const itemTarget = queueItemTargetFromEvent(event);
  if (!itemTarget) return;
  event.stopPropagation();
  openQueueItemPopover(itemTarget.item, itemTarget.itemEl);
});
queueTimelineWrap?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
  const itemTarget = queueItemTargetFromEvent(event);
  if (!itemTarget) return;
  event.preventDefault();
  openQueueItemPopover(itemTarget.item, itemTarget.itemEl);
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
  applyActiveView();
});

const initialSession = new URL(window.location.href).searchParams.get("session");
if (initialSession) {
  input.value = initialSession;
  loadSession(initialSession).catch((err) => updateStatus(err.message, ""));
}
