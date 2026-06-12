#!/usr/bin/env node
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { URL } = require("url");

const PROJECT_ROOT = __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const CODEX_HOME = path.resolve(
  (process.env.CODEX_HOME || path.join(os.homedir(), ".codex")).replace(/^~/, os.homedir()),
);
const QUEUE_DB = path.resolve(
  (
    process.env.QUEUE_SERVICE_DB ||
    path.join(os.homedir(), ".cache", "codex-queue-service", "queues.sqlite")
  ).replace(/^~/, os.homedir()),
);
const PORT = Number(process.env.PORT || 8787);
const MAX_QUEUE_ITEMS = Math.max(1, Number(process.env.MAX_QUEUE_ITEMS || 200) || 200);
const MAX_QUEUE_TIMELINE_ITEMS = Math.max(
  1,
  Number(process.env.MAX_QUEUE_TIMELINE_ITEMS || 200000) || 200000,
);
const QUEUE_TIMELINE_BINS = Math.max(1, Number(process.env.QUEUE_TIMELINE_BINS || 180) || 180);
const MAX_MARKER_DETAIL_CHARS = Number(process.env.MAX_MARKER_DETAIL_CHARS || 8000);
const MAX_SPAN_DETAIL_CHARS = Number(process.env.MAX_SPAN_DETAIL_CHARS || 12000);
const COMPACT_SPAN_DETAIL_CHARS = Number(process.env.COMPACT_SPAN_DETAIL_CHARS || 1400);
const COMPACT_MARKER_DETAIL_CHARS = Number(process.env.COMPACT_MARKER_DETAIL_CHARS || 900);
const COMPACT_PREVIEW_CHARS = Number(process.env.COMPACT_PREVIEW_CHARS || 700);
const REMOTE_SESSION_MAX_BUFFER = Number(process.env.REMOTE_SESSION_MAX_BUFFER_MB || 512) * 1024 * 1024;
const REMOTE_CACHE_DIR = path.join(os.homedir(), ".cache", "codex-session-timeline", "remote");
const SQLITE_COPY_DIR = path.join(os.tmpdir(), "codex-session-timeline-sqlite");
const MAX_RUNNING_DIAGNOSTIC_ITEMS = Number(process.env.MAX_RUNNING_DIAGNOSTIC_ITEMS || 8);
const MAX_LAUNCHER_EVENT_ROWS = Number(process.env.MAX_LAUNCHER_EVENT_ROWS || 500);
const MAX_LAUNCHER_WORKER_FILES = Number(process.env.MAX_LAUNCHER_WORKER_FILES || 500);
const COMPACTION_DEDUPE_WINDOW_MS = 100;
const REMOTE_HOSTS = {
  ...parseRemoteHosts(process.env.CODEX_TIMELINE_REMOTE_HOSTS || ""),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
};

function isSafeSessionId(id) {
  return /^[A-Za-z0-9_.:-]{8,96}$/.test(id || "");
}

function isSafeRemoteName(name) {
  return /^[A-Za-z0-9_.:-]{1,96}$/.test(name || "");
}

function parseRemoteHosts(value) {
  const result = {};
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [name, host] = trimmed.split("=");
    if (isSafeRemoteName(name) && isSafeRemoteName(host)) result[name] = host;
  }
  return result;
}

function resolveRemoteHost(remoteName) {
  if (!remoteName) return null;
  if (!isSafeRemoteName(remoteName)) throw new Error("Unsafe remote name.");
  const host = REMOTE_HOSTS[remoteName];
  if (!host) {
    const choices = Object.keys(REMOTE_HOSTS).sort().join(", ");
    const suffix = choices
      ? ` Known remotes: ${choices}`
      : " Configure remotes with CODEX_TIMELINE_REMOTE_HOSTS=name=ssh-host.";
    throw new Error(`Unknown remote '${remoteName}'.${suffix}`);
  }
  return host;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function safePathPart(value) {
  return String(value).replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function resolveCodexHome(value = "") {
  const raw = String(value || CODEX_HOME).replace(/^~/, os.homedir());
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`CODEX_HOME does not exist or is not a directory: ${resolved}`);
  }
  return resolved;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendText(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function parseJsonlText(text) {
  return text
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return parseJsonlText(fs.readFileSync(filePath, "utf8"));
}

function readFirstLine(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    let acc = "";
    const buf = Buffer.alloc(65536);
    while (!acc.includes("\n")) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      acc += buf.subarray(0, n).toString("utf8");
      if (acc.length > 2_000_000) break;
    }
    return acc.split(/\n/)[0] || "";
  } finally {
    fs.closeSync(fd);
  }
}

function sshText(host, command, maxBuffer = 64 * 1024 * 1024) {
  return execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, command],
    { encoding: "utf8", maxBuffer },
  );
}

function sshBuffer(host, command, maxBuffer = 512 * 1024 * 1024) {
  return execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, command],
    { maxBuffer },
  );
}

function loadRemoteSessionIndex(host) {
  const rows = parseJsonlText(
    sshText(host, "cat ~/.codex/session_index.jsonl 2>/dev/null || true"),
  );
  const byId = new Map();
  for (const row of rows) {
    if (row && row.id) byId.set(row.id, row);
  }
  return byId;
}

function resolveRemoteSessionFile(host, sessionId) {
  const pattern = `*${sessionId}*.jsonl`;
  const command =
    `find ~/.codex/sessions ~/.codex/archived_sessions -type f -name ${shellQuote(pattern)} ` +
    "2>/dev/null | sort | tail -1";
  return sshText(host, command).trim() || null;
}

function readRemoteJsonl(host, filePath) {
  return parseJsonlText(sshText(host, `cat ${shellQuote(filePath)}`, REMOTE_SESSION_MAX_BUFFER));
}

function findRemoteChildSessionFiles(host, parentId, spawnedIds) {
  const filesById = new Map();
  for (const id of spawnedIds || []) {
    const filePath = resolveRemoteSessionFile(host, id);
    if (filePath) filesById.set(id, filePath);
  }

  const pattern = `"parent_thread_id":"${parentId}"`;
  const command =
    `rg -l ${shellQuote(pattern)} ~/.codex/sessions ~/.codex/archived_sessions ` +
    "2>/dev/null || true";
  const output = sshText(host, command, 32 * 1024 * 1024);
  for (const filePath of output.split(/\n/).filter(Boolean)) {
    const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
    if (match) filesById.set(match[1], filePath);
  }

  return [...filesById.entries()].map(([id, filePath]) => ({ id, filePath }));
}

function walkJsonl(rootDir, visitor) {
  if (!fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        visitor(fullPath);
      }
    }
  }
}

function loadSessionIndex(codexHome = CODEX_HOME) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const byId = new Map();
  for (const row of readJsonl(indexPath)) {
    if (row && row.id) byId.set(row.id, row);
  }
  return byId;
}

function resolveSessionFile(sessionId, codexHome = CODEX_HOME) {
  const roots = [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions"),
  ];
  const matches = [];
  for (const root of roots) {
    walkJsonl(root, (filePath) => {
      if (path.basename(filePath).includes(sessionId)) matches.push(filePath);
    });
  }
  matches.sort();
  return matches[matches.length - 1] || null;
}

function findChildSessionFiles(parentId, spawnedIds, codexHome = CODEX_HOME) {
  const roots = [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions"),
  ];
  const filesById = new Map();
  const wanted = new Set(spawnedIds || []);

  for (const root of roots) {
    walkJsonl(root, (filePath) => {
      const base = path.basename(filePath);
      for (const id of wanted) {
        if (base.includes(id)) filesById.set(id, filePath);
      }
      if (!filesById.has(base)) {
        try {
          const first = readFirstLine(filePath);
          if (first.includes(`"parent_thread_id":"${parentId}"`)) {
            const match = base.match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
            if (match) filesById.set(match[1], filePath);
          }
        } catch {
          // Ignore unreadable rollouts.
        }
      }
    });
  }

  return [...filesById.entries()].map(([id, filePath]) => ({ id, filePath }));
}

function toMs(timestamp) {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function clampNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function parseWallMs(output) {
  if (typeof output !== "string") return null;
  const match = output.match(/Wall time:\s*([0-9.]+)\s*seconds/i);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

function parseExitCode(output) {
  if (typeof output !== "string") return null;
  const match = output.match(/Process exited with code\s+(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function extractToolJson(output) {
  if (typeof output !== "string") return null;
  const candidates = [];
  const trimmed = output.trim();
  candidates.push(trimmed);
  const marker = "\nOutput:\n";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex >= 0) candidates.push(trimmed.slice(markerIndex + marker.length).trim());
  const firstObject = trimmed.search(/[{[]/);
  if (firstObject > 0) candidates.push(trimmed.slice(firstObject).trim());

  for (const candidate of candidates) {
    if (!candidate || !/^[{[]/.test(candidate)) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Some outputs include extra non-JSON after the payload.
    }
  }
  return null;
}

function parseArgs(argumentsText) {
  if (!argumentsText || typeof argumentsText !== "string") return {};
  try {
    return JSON.parse(argumentsText);
  } catch {
    return {};
  }
}

function isWaitTool(name, wallMs) {
  if (!name) return false;
  if (name === "queue_wait_for_event" || name === "request_user_input") return true;
  if (/(\b|_)(wait|sleep|poll|watch)(\b|_)/i.test(name)) return true;
  return false && wallMs > 0;
}

function terminalSessionIdsFromOutput(output) {
  if (typeof output !== "string") return [];
  const ids = [];
  const re = /Process running with session ID\s+([0-9]+)/g;
  let match;
  while ((match = re.exec(output)) !== null) ids.push(match[1]);
  return ids;
}

function commandLooksLikeWait(cmd) {
  const text = String(cmd || "");
  if (!text) return false;
  if (/\bqueue\.py\s+wait\b/i.test(text)) return true;
  return /(^|[^\w-])(wait|sleep|poll|watch)([^\w-]|$)/i.test(text);
}

function commandWaitName(cmd) {
  const text = String(cmd || "");
  if (/\bqueue\.py\s+wait\b/i.test(text)) return "queue.py wait";
  const match = text.match(/(?:^|\s)([^\s"'`]+(?:wait|sleep|poll|watch)[^\s"'`]*)/i);
  return match ? `terminal ${path.basename(match[1])}` : "terminal wait";
}

function terminalWaitCall(call) {
  if (call?.name !== "exec_command" || !commandLooksLikeWait(call.args?.cmd)) return null;
  return {
    ...call,
    name: commandWaitName(call.args.cmd),
    originalName: call.name,
    terminalCommand: true,
  };
}

function semanticToolCall(call, terminalSessions = new Map()) {
  if (!call) return call;
  if (
    call.name === "write_stdin" &&
    call.args?.session_id != null &&
    String(call.args?.chars || "") === ""
  ) {
    const terminal = terminalSessions.get(String(call.args.session_id));
    if (terminal) {
      return {
        ...terminal,
        callId: call.callId,
        start: call.start,
        originalName: call.name,
        terminalSessionId: String(call.args.session_id),
        terminalPollArgs: call.args,
      };
    }
  }
  return terminalWaitCall(call) || call;
}

function summarizeTool(name, args) {
  if (!name) return "tool";
  if (name.startsWith("queue_")) {
    const parts = [name];
    if (args.namespace) parts.push(args.namespace);
    if (args.queue_name) parts.push(args.queue_name);
    if (Array.isArray(args.queue_names) && args.queue_names.length) parts.push(args.queue_names.join(", "));
    return parts.join(" ");
  }
  if (name === "spawn_agent") return "spawn_agent";
  return name;
}

function clipMarkerDetail(value) {
  const text = String(value || "").trim();
  if (text.length <= MAX_MARKER_DETAIL_CHARS) return text;
  const omitted = text.length - MAX_MARKER_DETAIL_CHARS;
  return `${text.slice(0, MAX_MARKER_DETAIL_CHARS)}\n\n... truncated ${omitted} chars`;
}

function textFromContent(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map(textFromContent)
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.message === "string") return value.message;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return textFromContent(value.content);
  }
  return "";
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || "");
  }
}

function safeParseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function clipText(value, max = 1200) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n... truncated ${omitted} chars`;
}

function clipSpanDetail(value) {
  const text = String(value || "").trim();
  if (text.length <= MAX_SPAN_DETAIL_CHARS) return text;
  const omitted = text.length - MAX_SPAN_DETAIL_CHARS;
  return `${text.slice(0, MAX_SPAN_DETAIL_CHARS)}\n\n... truncated ${omitted} chars`;
}

function queueNamesFromArgs(args) {
  if (!args || typeof args !== "object") return [];
  if (Array.isArray(args.queue_names)) return args.queue_names.filter(Boolean);
  if (args.queue_name) return [args.queue_name];
  return [];
}

function waitTargetSummary(name, args) {
  if (name === "queue_wait_for_event") {
    const lines = ["Waiting for queue event"];
    if (args.namespace) lines.push(`namespace: ${args.namespace}`);
    const queues = queueNamesFromArgs(args);
    if (queues.length) lines.push(`queues: ${queues.join(", ")}`);
    if (Array.isArray(args.return_on) && args.return_on.length) {
      lines.push(`return on: ${args.return_on.join(", ")}`);
    }
    if (args.timeout_seconds != null) lines.push(`timeout: ${args.timeout_seconds}s`);
    if (args.poll_seconds != null) lines.push(`poll interval: ${args.poll_seconds}s`);
    if (args.include_completed != null) lines.push(`include completed: ${Boolean(args.include_completed)}`);
    if (args.since_signature != null) {
      lines.push(`since signature: ${typeof args.since_signature === "string" ? "provided" : "provided, non-string"}`);
    }
    return lines.join("\n");
  }

  if (name === "request_user_input") return "Waiting for user input";

  const queues = queueNamesFromArgs(args);
  if (queues.length) return `Waiting on queues: ${queues.join(", ")}`;
  return `Waiting via ${name || "tool"}`;
}

function toolSpanType(name, wallMs) {
  if (isWaitTool(name, wallMs)) return "wait";
  if (name === "spawn_agent") return "spawn";
  return "tool";
}

function parsedOutputSummary(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  if (Array.isArray(parsed)) return safeJson(parsed.slice(0, 4));

  const summary = {};
  for (const key of [
    "filters",
    "counts",
    "result_metrics",
    "queue_count",
    "active_queue_count",
    "inactive_queue_count",
    "included_queue_count",
    "omitted_queue_count",
    "requested_count",
    "created_count",
    "existing_count",
    "failed_count",
    "created_ids_preview",
    "existing_ids_preview",
  ]) {
    if (parsed[key] != null) summary[key] = parsed[key];
  }

  if (Array.isArray(parsed.queues) && parsed.queues.length) {
    summary.queues = parsed.queues.slice(0, 4).map((entry) => ({
      namespace: entry.queue?.namespace || entry.namespace,
      name: entry.queue?.name || entry.name,
      counts: entry.counts || entry.queue?.counts,
      item_count: Array.isArray(entry.items) ? entry.items.length : undefined,
    }));
  }

  if (!Object.keys(summary).length) return safeJson(parsed);
  return safeJson(summary);
}

function outputPayloadText(output) {
  if (typeof output !== "string") return "";
  const marker = "\nOutput:\n";
  const markerIndex = output.indexOf(marker);
  return markerIndex >= 0 ? output.slice(markerIndex + marker.length).trim() : output.trim();
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  const totalMs = Math.round(ms);
  if (totalMs < 1000) return `${totalMs}ms`;

  let remaining = totalMs;
  const hours = Math.floor(remaining / 3600000);
  remaining -= hours * 3600000;
  const minutes = Math.floor(remaining / 60000);
  remaining -= minutes * 60000;
  const seconds = Math.floor(remaining / 1000);
  remaining -= seconds * 1000;

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes || hours) parts.push(`${minutes}m`);
  if (seconds || minutes || hours) parts.push(`${seconds}s`);
  if (remaining) parts.push(`${remaining}ms`);
  return parts.join(" ");
}

function toolArgumentSections(call) {
  const sections = [];
  const argsText = safeJson(call.args || {});
  const pollArgsText = call.terminalPollArgs ? safeJson(call.terminalPollArgs) : "";

  if (pollArgsText && pollArgsText !== "{}") {
    sections.push(`Terminal poll arguments:\n${pollArgsText}`);
  }
  if (argsText && argsText !== "{}") {
    sections.push(`${call.terminalPollArgs ? "Original command arguments" : "Arguments"}:\n${argsText}`);
  }
  return sections;
}

function toolArgsPreview(call) {
  return clipSpanDetail(toolArgumentSections(call).join("\n\n") || safeJson(call.args || {}));
}

function spanDetail(call, type, durationMs, wallMs, exitCode, parsed, output) {
  const outputSummary = parsedOutputSummary(parsed);
  const outputText = outputPayloadText(output);
  const sections = [
    `Tool: ${call.name}`,
    `Duration: ${formatDurationMs(durationMs)}${wallMs == null ? "" : `\nReported wall time: ${formatDurationMs(wallMs)}`}`,
  ];

  if (call.originalName && call.originalName !== call.name && !call.terminalCommand) {
    sections.push(`Underlying tool: ${call.originalName}`);
  }
  if (call.terminalPollArgs && call.originalName) sections.push(`Terminal poll tool: ${call.originalName}`);
  if (call.terminalSessionId) sections.push(`Terminal session: ${call.terminalSessionId}`);
  if (exitCode != null) sections.push(`Exit code: ${exitCode}`);
  if (type === "wait") sections.push(`Wait target:\n${waitTargetSummary(call.name, call.args || {})}`);
  sections.push(...toolArgumentSections(call));
  if (outputSummary) sections.push(`Parsed output summary:\n${outputSummary}`);
  if (outputText && !outputSummary) sections.push(`Output:\n${outputText}`);

  return clipSpanDetail(sections.filter(Boolean).join("\n\n"));
}

function runningSpanDetail(call, type, durationMs) {
  const sections = [
    `Tool: ${call.name}`,
    "Status: running; no completion record has been written to the transcript yet.",
    `Elapsed so far: ${formatDurationMs(durationMs)}`,
    "What this means: the parent thread is inside this tool call and is waiting for its result before it can write the next assistant message.",
  ];

  if (call.originalName && call.originalName !== call.name && !call.terminalCommand) {
    sections.push(`Underlying tool: ${call.originalName}`);
  }
  if (call.terminalPollArgs && call.originalName) sections.push(`Terminal poll tool: ${call.originalName}`);
  if (call.terminalSessionId) sections.push(`Terminal session: ${call.terminalSessionId}`);
  if (type === "wait") sections.push(`Wait target:\n${waitTargetSummary(call.name, call.args || {})}`);
  sections.push(...toolArgumentSections(call));
  return clipSpanDetail(sections.filter(Boolean).join("\n\n"));
}

function interruptedSpanDetail(call, type, durationMs, reason) {
  const sections = [
    `Tool: ${call.name}`,
    "Status: no completion record was written before the transcript advanced.",
    `Duration shown: ${formatDurationMs(durationMs)}`,
    reason ? `Closed by timeline parser: ${reason}` : "",
  ];

  if (call.originalName && call.originalName !== call.name && !call.terminalCommand) {
    sections.push(`Underlying tool: ${call.originalName}`);
  }
  if (call.terminalPollArgs && call.originalName) sections.push(`Terminal poll tool: ${call.originalName}`);
  if (call.terminalSessionId) sections.push(`Terminal session: ${call.terminalSessionId}`);
  if (type === "wait") sections.push(`Wait target:\n${waitTargetSummary(call.name, call.args || {})}`);
  sections.push(...toolArgumentSections(call));
  return clipSpanDetail(sections.filter(Boolean).join("\n\n"));
}

function openToolCallBoundaryReason(row, payloadType, payload) {
  if (payloadType === "task_started") return "next task started";
  if (row.type === "turn_context") return "next turn context started";
  if (payloadType === "user_message") return "next user message";
  if (payloadType === "turn_aborted") return "turn aborted";
  if (payloadType === "agent_message" && payload.phase === "final_answer") return "final answer emitted";
  if (row.type === "event_msg" && payloadType === "task_complete") return "task completed";
  return "";
}

function closeInterruptedToolCalls(toolCalls, terminalSessions, spans, endMs, reason, launcherHints) {
  if (!Number.isFinite(endMs) || !toolCalls.size) return;
  for (const call of toolCalls.values()) {
    if (!Number.isFinite(call.start) || call.start > endMs) continue;
    const displayCall = semanticToolCall(call, terminalSessions);
    collectLauncherHintsFromCall(displayCall, launcherHints, endMs);
    const type = toolSpanType(displayCall.name, null);
    const label = summarizeTool(displayCall.name, displayCall.args);
    const durationMs = Math.max(1, endMs - call.start);
    spans.push({
      id: displayCall.callId,
      type,
      status: "interrupted",
      name: displayCall.name,
      label,
      args: displayCall.args || {},
      start: displayCall.start,
      end: endMs,
      durationMs,
      wallMs: null,
      exitCode: null,
      waitTarget: type === "wait" ? waitTargetSummary(displayCall.name, displayCall.args) : "",
      argsPreview: toolArgsPreview(displayCall),
      outputPreview: "No completion record before transcript boundary.",
      detail: interruptedSpanDetail(displayCall, type, durationMs, reason),
    });
  }
  toolCalls.clear();
}

function markerAttachments(payload) {
  const attachments = [];
  if (Array.isArray(payload.images) && payload.images.length) {
    attachments.push(`${payload.images.length} image${payload.images.length === 1 ? "" : "s"}`);
  }
  if (Array.isArray(payload.local_images) && payload.local_images.length) {
    attachments.push(
      `${payload.local_images.length} local image${payload.local_images.length === 1 ? "" : "s"}`,
    );
  }
  return attachments.length ? `Attachments: ${attachments.join(", ")}` : "";
}

function markerDetail(type, payload) {
  if (type === "compact") {
    return clipMarkerDetail(
      payload.message || "Context was compacted at this point. Replacement history is hidden here.",
    );
  }

  const message = textFromContent(payload.message || payload.content || payload.text_elements);
  const attachments = markerAttachments(payload);
  if (message || attachments) {
    return clipMarkerDetail([message, attachments].filter(Boolean).join("\n\n"));
  }

  if (type === "goal" && payload.goal) return clipMarkerDetail(safeJson(payload.goal));
  if (type === "abort") return clipMarkerDetail(payload.reason || safeJson(payload));
  if (type === "task") {
    return clipMarkerDetail(
      safeJson({
        turn_id: payload.turn_id,
        trace_id: payload.trace_id,
        model_context_window: payload.model_context_window,
        collaboration_mode_kind: payload.collaboration_mode_kind,
      }),
    );
  }
  return "";
}

function makeMarker(ts, type, label, payload) {
  return {
    ts,
    type,
    label,
    payloadType: payload.type || "",
    detail: markerDetail(type, payload),
  };
}

function appTimestampMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1_000_000_000_000 ? Math.round(n) : Math.round(n * 1000);
}

function threadStatusText(status) {
  if (!status) return "";
  if (typeof status === "string") return status;
  if (typeof status.type === "string") return status.type;
  return safeJson(status);
}

function extractPromptField(prompt, label) {
  const match = String(prompt || "").match(new RegExp(`^\\s*-?\\s*${escapeRegExp(label)}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function extractDelegationInput(text) {
  const match = String(text || "").match(/<input>([\s\S]*?)<\/input>/i);
  if (!match) return "";
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function appThreadPromptFromRecord(record, thread) {
  return (
    record.prompt ||
    extractDelegationInput(thread?.preview) ||
    String(thread?.preview || "").trim()
  );
}

function appWorkerNameFromPrompt(prompt) {
  const text = String(prompt || "");
  const explicit = extractPromptField(text, "Worker id");
  if (explicit) return explicit;

  const commandArg = text.match(/(?:^|\s)(?:python\d*|uv\s+run\s+python\d*)\s+\S*(?:worker|agent)[^\s]*\s+([A-Za-z0-9_.:-]+)/im);
  if (commandArg) return commandArg[1].replace(/[.,;:)]+$/, "");

  const appWorker = text.match(/\b(?:queue\s+)?worker\s+([A-Za-z0-9_.:-]+)(?:\b|[.\s])/i);
  if (appWorker) return appWorker[1].replace(/[.,;:)]+$/, "");

  return "";
}

function threadItemText(item) {
  if (!item || typeof item !== "object") return "";
  return textFromContent(item.text || item.message || item.content || item.output || item.result);
}

function appTurnFinalText(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const final = items
    .slice()
    .reverse()
    .find((item) => item.phase === "final_answer" || item.type === "final_answer");
  return threadItemText(final);
}

function ensureAppThreadRecord(records, id) {
  if (!id) return null;
  if (!records.has(id)) {
    records.set(id, {
      id,
      create: null,
      archives: [],
      reads: [],
      prompt: "",
      projectId: "",
      thinking: "",
    });
  }
  return records.get(id);
}

function appThreadMarker(ts, label, detail) {
  return {
    ts,
    type: "app",
    label,
    payloadType: "codex_app",
    detail: clipMarkerDetail(detail),
  };
}

function appThreadSpanDetail(record, thread, turn, snapshot, start, end) {
  const finalText = appTurnFinalText(turn);
  const prompt = appThreadPromptFromRecord(record, thread);
  const sections = [
    "App-server worker turn",
    `Thread ID: ${record.id}`,
    record.workerName ? `Worker ID: ${record.workerName}` : "",
    thread?.title ? `Thread title: ${thread.title}` : "",
    thread?.cwd || record.projectId ? `Working directory/project: ${thread?.cwd || record.projectId}` : "",
    `Status at last read: ${threadStatusText(thread?.status) || turn?.status || "unknown"}`,
    `Started: ${new Date(start).toISOString()}`,
    end ? `Observed through: ${new Date(end).toISOString()}` : "",
    `Duration shown: ${formatDurationMs(Math.max(0, end - start))}`,
    snapshot?.readAt ? `Last read_thread snapshot: ${new Date(snapshot.readAt).toISOString()}` : "",
    finalText ? `Final answer:\n${finalText}` : "",
    prompt ? `Original create_thread prompt:\n${prompt}` : "",
  ];
  return clipSpanDetail(sections.filter(Boolean).join("\n\n"));
}

function appThreadLaunchDetail(record) {
  const sections = [
    "App-server create_thread",
    `Thread ID: ${record.id}`,
    record.workerName ? `Worker ID: ${record.workerName}` : "",
    record.projectId ? `Project: ${record.projectId}` : "",
    record.thinking ? `Thinking: ${record.thinking}` : "",
    record.create?.callId ? `Call ID: ${record.create.callId}` : "",
    record.prompt ? `Prompt:\n${record.prompt}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

function appThreadArchiveDetail(record, archive) {
  return [
    "App-server set_thread_archived",
    `Thread ID: ${record.id}`,
    archive.archived == null ? "" : `Archived: ${Boolean(archive.archived)}`,
    archive.callId ? `Call ID: ${archive.callId}` : "",
  ].filter(Boolean).join("\n\n");
}

function appThreadSessions(records, parentId) {
  const result = [];
  for (const record of records.values()) {
    const latestRead = record.reads[record.reads.length - 1] || null;
    const thread = latestRead?.thread || {};
    const prompt = appThreadPromptFromRecord(record, thread);
    const workerName = appWorkerNameFromPrompt(prompt);
    record.workerName = workerName;

    const markers = [];
    const spans = [];
    const createdAt = appTimestampMs(thread.createdAt);
    const updatedAt = appTimestampMs(thread.updatedAt);

    if (record.create?.end) {
      markers.push(appThreadMarker(record.create.end, "app thread created", appThreadLaunchDetail(record)));
    }

    if (record.create?.start && record.create?.end && record.create.end >= record.create.start) {
      const durationMs = Math.max(1, record.create.end - record.create.start);
      spans.push({
        id: `${record.id}:create`,
        type: "spawn",
        name: "codex_app.create_thread",
        label: "create_thread",
        start: record.create.start,
        end: record.create.end,
        durationMs,
        wallMs: null,
        exitCode: null,
        detail: clipSpanDetail(appThreadLaunchDetail(record)),
      });
    }

    for (const read of record.reads) {
      markers.push(
        appThreadMarker(
          read.readAt,
          "app thread read",
          [
            "App-server read_thread snapshot",
            `Thread ID: ${record.id}`,
            `Status: ${threadStatusText(read.thread?.status) || "unknown"}`,
            `Turns returned: ${read.turns.length}`,
          ].join("\n"),
        ),
      );

      for (const turn of read.turns) {
        const turnStart = appTimestampMs(turn.startedAt) || createdAt || record.create?.end || read.readAt;
        let turnEnd = appTimestampMs(turn.completedAt);
        if (!turnEnd && Number.isFinite(turn.durationMs)) turnEnd = turnStart + Math.max(1, Number(turn.durationMs));
        if (!turnEnd) turnEnd = read.readAt || updatedAt || turnStart;
        if (!Number.isFinite(turnStart) || !Number.isFinite(turnEnd) || turnEnd < turnStart) continue;

        const durationMs = Math.max(1, turnEnd - turnStart);
        const status = turn.status || threadStatusText(read.thread?.status) || "observed";
        spans.push({
          id: `${record.id}:${turn.id || spans.length}`,
          type: "tool",
          name: "app_server_worker_turn",
          label: `worker turn ${status}`,
          start: turnStart,
          end: turnEnd,
          durationMs,
          wallMs: Number.isFinite(turn.durationMs) ? Number(turn.durationMs) : null,
          exitCode: null,
          detail: appThreadSpanDetail(record, read.thread, turn, read, turnStart, turnEnd),
        });
      }
    }

    for (const archive of record.archives) {
      markers.push(appThreadMarker(archive.ts, "app thread archived", appThreadArchiveDetail(record, archive)));
    }

    const points = [
      record.create?.start,
      record.create?.end,
      createdAt,
      updatedAt,
      ...spans.flatMap((span) => [span.start, span.end]),
      ...markers.map((marker) => marker.ts),
    ].filter(Number.isFinite);
    if (!points.length) continue;

    const start = Math.min(...points);
    const end = Math.max(...points);
    const elapsedMs = Math.max(0, end - start);
    const waitMs = unionMs(spans.filter((s) => s.type === "wait"));
    const toolMs = unionMs(spans.filter((s) => s.type !== "wait"));
    const busyMs = unionMs(spans);

    result.push({
      id: record.id,
      title: workerName || thread.title || "app-server thread",
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      filePath: "codex_app thread snapshot from parent transcript",
      meta: {
        id: record.id,
        parentThreadId: parentId || null,
        cwd: thread.cwd || record.projectId || "",
        source: {
          app_server: {
            thread_id: record.id,
            worker_id: workerName,
            job_id: extractPromptField(prompt, "Job id"),
            project_id: record.projectId,
            created_via: "codex_app.create_thread",
            read_snapshots: record.reads.length,
            archived: record.archives.some((archive) => archive.archived !== false),
            thread_status: threadStatusText(thread.status),
            prompt,
          },
        },
        threadSource: "app_server",
        originator: "codex_app",
        agentNickname: workerName,
        agentRole: workerName ? "app worker" : "app thread",
      },
      start,
      end,
      elapsedMs,
      metrics: {
        waitMs,
        toolMs,
        quietMs: Math.max(0, elapsedMs - busyMs),
        busyMs,
        spanCount: spans.length,
        eventCount: markers.length,
      },
      eventCounts: {},
      spans,
      markers: normalizedMarkers(markers.filter((marker) => marker.ts)),
      spawned: [],
      namespaces: [],
      appServerThread: true,
    });
  }

  return result.sort((a, b) => clampNumber(a.start) - clampNumber(b.start));
}

function launcherWorkerKey(record) {
  const launcher = record.launcher || {};
  return (
    record.threadId ||
    launcher.thread_id ||
    record.workerId ||
    launcher.worker_id ||
    launcher.done_file ||
    launcher.events_file ||
    launcher.cwd ||
    ""
  );
}

function normalizeLauncherWorkerRecord(value, observedAt) {
  if (!value || typeof value !== "object") return null;
  const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata : {};
  const launcher =
    metadata.launcher && typeof metadata.launcher === "object"
      ? metadata.launcher
      : value.launcher && typeof value.launcher === "object"
        ? value.launcher
        : value;
  const workerId = value.worker_id || launcher.worker_id || "";
  const threadId = value.thread_id || launcher.thread_id || "";
  const hasLauncherShape = Boolean(
    metadata.launcher ||
      value.launcher ||
      launcher.done_file ||
      launcher.events_file ||
      launcher.ready_file ||
      launcher.app_server_pid ||
      launcher.launcher_pid,
  );

  if (!workerId || !hasLauncherShape) return null;

  return {
    workerId,
    threadId,
    jobId: value.job_id || launcher.job_id || "",
    status: value.status || launcher.status || "",
    createdAt: appTimestampMs(value.created_at || value.createdAt || launcher.created_at),
    updatedAt: appTimestampMs(
      value.updated_at || value.last_queue_action_at || value.last_observed_at || launcher.updated_at,
    ),
    observedAt,
    lastError: value.last_error || launcher.error || null,
    projectId: metadata.project_id || value.project_id || "",
    promptFile: metadata.prompt_file || value.prompt_file || "",
    workerConfig: metadata.worker_config || value.worker_config || "",
    launcher,
  };
}

function mergeLauncherWorkerRecord(records, value, observedAt) {
  const normalized = normalizeLauncherWorkerRecord(value, observedAt);
  if (!normalized) return;
  const key = launcherWorkerKey(normalized);
  if (!key) return;
  const existing = records.get(key) || {};
  const mergedLauncher = {
    ...(existing.launcher || {}),
    ...(normalized.launcher || {}),
  };
  records.set(key, {
    workerId: normalized.workerId || existing.workerId || "",
    threadId: normalized.threadId || existing.threadId || "",
    jobId: normalized.jobId || existing.jobId || "",
    status: normalized.status || existing.status || "",
    lastError: normalized.lastError || existing.lastError || null,
    projectId: normalized.projectId || existing.projectId || "",
    promptFile: normalized.promptFile || existing.promptFile || "",
    workerConfig: normalized.workerConfig || existing.workerConfig || "",
    launcher: mergedLauncher,
    createdAt:
      existing.createdAt && normalized.createdAt
        ? Math.min(existing.createdAt, normalized.createdAt)
        : existing.createdAt || normalized.createdAt || null,
    updatedAt:
      existing.updatedAt && normalized.updatedAt
        ? Math.max(existing.updatedAt, normalized.updatedAt)
        : existing.updatedAt || normalized.updatedAt || null,
    observedAt:
      existing.observedAt && normalized.observedAt
        ? Math.max(existing.observedAt, normalized.observedAt)
        : existing.observedAt || normalized.observedAt || null,
  });
}

function launcherWorkerWithDoneFile(record) {
  const doneFile = record?.launcher?.done_file || "";
  if (!doneFile || !fs.existsSync(doneFile)) return record;
  try {
    const done = JSON.parse(fs.readFileSync(doneFile, "utf8"));
    return {
      ...record,
      workerId: record.workerId || done.worker_id || "",
      threadId: record.threadId || done.thread_id || "",
      jobId: record.jobId || done.job_id || "",
      status: done.status || record.status || "",
      lastError: record.lastError || done.error || null,
      launcher: {
        ...(record.launcher || {}),
        ...done,
      },
    };
  } catch {
    return record;
  }
}

function commandOptionValue(command, optionName) {
  const re = new RegExp(
    `(?:^|\\s)--${escapeRegExp(optionName)}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))`,
  );
  const match = String(command || "").match(re);
  return match ? (match[1] || match[2] || match[3] || "").trim() : "";
}

function inferProjectlessRootFromDb(dbPath) {
  if (!dbPath) return "";
  return path.join(path.dirname(dbPath), "projectless-workers");
}

function inferPromptDirFromDb(dbPath) {
  if (!dbPath) return "";
  return path.join(path.dirname(dbPath), "prompts");
}

function mergeLauncherHint(hints, hint) {
  if (!hint?.projectlessRoot || !hint?.jobId) return;
  const key = `${hint.jobId}\0${hint.projectlessRoot}`;
  const existing = hints.get(key) || {};
  hints.set(key, {
    ...existing,
    ...hint,
    observedAt:
      existing.observedAt && hint.observedAt
        ? Math.max(existing.observedAt, hint.observedAt)
        : existing.observedAt || hint.observedAt || null,
  });
}

function launcherHintFromDbJob(dbPath, jobId, observedAt, extra = {}) {
  if (!dbPath || !jobId) return null;
  return {
    dbPath,
    jobId,
    projectlessRoot: extra.projectlessRoot || inferProjectlessRootFromDb(dbPath),
    promptDir: extra.promptDir || inferPromptDirFromDb(dbPath),
    projectId: extra.projectId || "",
    observedAt,
  };
}

function collectLauncherHintsFromCall(call, hints, observedAt) {
  const args = call?.args || {};
  if (args.db && args.job_id) {
    mergeLauncherHint(hints, launcherHintFromDbJob(args.db, args.job_id, observedAt));
  }

  const cmd = args.cmd || "";
  if (!cmd) return;

  const dbPath = commandOptionValue(cmd, "db");
  const jobId = commandOptionValue(cmd, "job-id");
  if (!dbPath || !jobId) return;

  mergeLauncherHint(
    hints,
    launcherHintFromDbJob(dbPath, jobId, observedAt, {
      projectlessRoot: commandOptionValue(cmd, "projectless-root") || "",
      promptDir: commandOptionValue(cmd, "prompt-dir") || "",
      projectId: commandOptionValue(cmd, "project-id") || "",
    }),
  );
}

function launcherMetadataDirs(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const limit = Math.max(1, Number(MAX_LAUNCHER_WORKER_FILES) || 500);
  const dirs = new Set();
  const stack = [rootDir];
  while (stack.length && dirs.size < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name === "done.json" || entry.name === "ready.json" || entry.name === "events.jsonl") &&
        path.basename(path.dirname(fullPath)) === ".codex-worker-launcher"
      ) {
        dirs.add(path.dirname(fullPath));
        if (dirs.size >= limit) break;
      }
    }
  }
  return [...dirs].sort();
}

function launcherSidecarPath(launcherDir, name) {
  return path.join(launcherDir, name);
}

function launcherWorkerDirFromMetadataDir(launcherDir) {
  return path.dirname(launcherDir);
}

function readLauncherJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function fileTimestampMs(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return Math.round(fs.statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}

function collectLauncherWorkersFromHints(hints, records) {
  for (const hint of hints.values()) {
    for (const launcherDir of launcherMetadataDirs(hint.projectlessRoot)) {
      const doneFile = launcherSidecarPath(launcherDir, "done.json");
      const readyFile = launcherSidecarPath(launcherDir, "ready.json");
      const statusFile = launcherSidecarPath(launcherDir, "status.json");
      const eventsFile = launcherSidecarPath(launcherDir, "events.jsonl");
      const done = readLauncherJson(doneFile);
      const ready = readLauncherJson(readyFile);
      const statusState = readLauncherJson(statusFile);
      const metadata = {
        ...(ready || {}),
        ...(statusState || {}),
        ...(done || {}),
      };
      if (!metadata.worker_id && !metadata.thread_id) continue;
      if (hint.jobId && metadata.job_id && metadata.job_id !== hint.jobId) continue;
      const missingDoneMarker = !done;
      const workerId = metadata.worker_id || "";
      const promptFile = workerId && hint.promptDir ? path.join(hint.promptDir, `${workerId}.md`) : "";
      const workerConfig = workerId && hint.promptDir ? path.join(hint.promptDir, `${workerId}.json`) : "";
      mergeLauncherWorkerRecord(
        records,
        {
          worker_id: workerId,
          thread_id: metadata.thread_id || "",
          job_id: metadata.job_id || hint.jobId,
          status: metadata.status || (missingDoneMarker ? "started; no done marker" : ""),
          created_at: fileTimestampMs(readyFile) || fileTimestampMs(eventsFile) || null,
          updated_at: fileTimestampMs(doneFile) || fileTimestampMs(eventsFile) || fileTimestampMs(readyFile) || null,
          metadata: {
            project_id: hint.projectId || "",
            prompt_file: fs.existsSync(promptFile) ? promptFile : "",
            worker_config: fs.existsSync(workerConfig) ? workerConfig : "",
            launcher: {
              ...metadata,
              cwd: metadata.cwd || launcherWorkerDirFromMetadataDir(launcherDir),
              done_file: done ? doneFile : "",
              status_file: fs.existsSync(statusFile) ? statusFile : metadata.status_file || "",
              missing_done_marker: missingDoneMarker,
              events_file: eventsFile,
              ready_file: fs.existsSync(readyFile) ? readyFile : "",
              launcher_log: launcherSidecarPath(launcherDir, "launcher.log"),
              app_server_stderr_file: launcherSidecarPath(launcherDir, "app-server.stderr.log"),
            },
          },
        },
        hint.observedAt,
      );
    }
  }
}

function collectLauncherWorkersFromParsed(value, records, observedAt, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectLauncherWorkersFromParsed(item, records, observedAt, depth + 1);
    return;
  }

  mergeLauncherWorkerRecord(records, value, observedAt);

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      collectLauncherWorkersFromParsed(child, records, observedAt, depth + 1);
    }
  }
}

function readOptionalText(filePath, maxChars = 8000) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... truncated ${text.length - maxChars} chars`;
  } catch {
    return "";
  }
}

function launcherEventRows(filePath, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) return { rows: [], totalRows: 0, truncated: false };
  const rows = readJsonl(filePath);
  const allEvents = options.launcherEventsMode === "all";
  if (allEvents) {
    return {
      rows,
      totalRows: rows.length,
      retainedRows: rows.length,
      omittedRows: 0,
      truncated: false,
      window: "all",
    };
  }
  const limit = Math.max(0, Number(MAX_LAUNCHER_EVENT_ROWS) || 0);
  if (!limit || rows.length <= limit) {
    return {
      rows,
      totalRows: rows.length,
      retainedRows: rows.length,
      omittedRows: 0,
      truncated: false,
      window: "all",
    };
  }
  const start = rows.length - limit;
  return {
    rows: rows.slice(start),
    totalRows: rows.length,
    retainedRows: limit,
    omittedRows: start,
    truncated: true,
    window: "latest",
  };
}

function launcherToolCallFromItem(item, start) {
  if (!item || typeof item !== "object" || !item.id) return null;
  if (item.type === "mcpToolCall") {
    return {
      callId: item.id,
      name: item.tool || item.server || "mcp_tool_call",
      namespace: item.server || "",
      start,
      args: item.arguments || {},
    };
  }
  if (item.type === "commandExecution") {
    const command =
      Array.isArray(item.commandActions) && item.commandActions[0]?.command
        ? item.commandActions[0].command
        : item.command || "";
    return {
      callId: item.id,
      name: "exec_command",
      namespace: "",
      start,
      args: {
        cmd: command,
        cwd: item.cwd || "",
      },
    };
  }
  return null;
}

function launcherSpanFromCall(call, end, output, parsed = null, wallMs = null, exitCode = null) {
  const displayCall = semanticToolCall(call);
  const type = toolSpanType(displayCall.name, wallMs);
  const durationMs = Math.max(1, end - displayCall.start);
  return {
    id: displayCall.callId,
    type,
    name: displayCall.name,
    label: summarizeTool(displayCall.name, displayCall.args),
    start: displayCall.start,
    end,
    durationMs,
    wallMs,
    exitCode,
    waitTarget: type === "wait" ? waitTargetSummary(displayCall.name, displayCall.args) : "",
    argsPreview: toolArgsPreview(displayCall),
    outputPreview: clipSpanDetail(parsedOutputSummary(parsed) || outputPayloadText(output || "")),
    detail: spanDetail(displayCall, type, durationMs, wallMs, exitCode, parsed, output || ""),
  };
}

function parseLauncherEvents(filePath, options = {}) {
  const { rows, totalRows, retainedRows, omittedRows, truncated, window } = launcherEventRows(filePath, options);
  const toolCalls = new Map();
  const itemStarts = new Map();
  const spans = [];
  const markers = [];
  const eventCounts = {};
  let thread = {};
  let start = null;
  let end = null;

  for (const row of rows) {
    const ts = toMs(row.recorded_at);
    if (ts) {
      start = start == null ? ts : Math.min(start, ts);
      end = end == null ? ts : Math.max(end, ts);
    }
    const event = row.event || "";
    eventCounts[event] = (eventCounts[event] || 0) + 1;
    const params = row.payload?.params || {};
    const item = params.item || {};

    if (event === "thread_started" && params.thread) {
      thread = params.thread;
      markers.push(
        appThreadMarker(
          ts,
          "launcher thread started",
          [
            "Projectless app-server thread started",
            `Thread ID: ${params.thread.id || params.thread.threadId || ""}`,
            params.thread.cwd ? `Working directory: ${params.thread.cwd}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    } else if (event === "turn_started" && params.turn) {
      markers.push(
        appThreadMarker(
          ts,
          "launcher turn started",
          [
            "Projectless app-server worker turn started",
            `Turn ID: ${params.turn.id || ""}`,
            params.threadId ? `Thread ID: ${params.threadId}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    } else if (event === "thread_status_changed") {
      const status = threadStatusText(params.status);
      if (status) {
        markers.push(
          appThreadMarker(
            ts,
            `launcher status ${status}`,
            [`Projectless app-server worker status: ${status}`, params.threadId ? `Thread ID: ${params.threadId}` : ""]
              .filter(Boolean)
              .join("\n"),
          ),
        );
      }
    } else if (event === "launcher_status") {
      const status = row.status || row.payload?.status || "";
      markers.push(
        appThreadMarker(
          ts,
          status ? `launcher ${status}` : "launcher status",
          [
            "Projectless app-server launcher status",
            status ? `Status: ${status}` : "",
            row.worker_id ? `Worker ID: ${row.worker_id}` : "",
            row.thread_id ? `Thread ID: ${row.thread_id}` : "",
            row.turn_id ? `Turn ID: ${row.turn_id}` : "",
            row.error ? `Error:\n${safeJson(row.error)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    }

    if (event === "rawResponseItem_completed" && item.type === "function_call") {
      const callId = item.call_id || item.id;
      if (callId) {
        toolCalls.set(callId, {
          callId,
          name: item.name || "function_call",
          namespace: item.namespace || "",
          start: ts,
          args: parseArgs(item.arguments),
        });
      }
    } else if (event === "rawResponseItem_completed" && item.type === "function_call_output") {
      const callId = item.call_id || item.id;
      const call = callId ? toolCalls.get(callId) : null;
      if (call && ts && call.start) {
        const parsed = extractToolJson(item.output);
        spans.push(
          launcherSpanFromCall(
            call,
            ts,
            item.output,
            parsed,
            parseWallMs(item.output),
            parseExitCode(item.output),
          ),
        );
        toolCalls.delete(callId);
      }
    } else if (event === "item_started") {
      const call = launcherToolCallFromItem(item, appTimestampMs(params.startedAtMs) || ts);
      if (call) itemStarts.set(item.id, call);
    } else if (event === "item_completed") {
      const call = itemStarts.get(item.id);
      if (call && !toolCalls.has(item.id)) {
        const completedAt = appTimestampMs(params.completedAtMs) || ts;
        if (completedAt && completedAt >= call.start) {
          const parsed = item.result?.structuredContent || item.result || null;
          const output = parsed ? `Output:\n${safeJson(parsed)}` : "";
          spans.push(
            launcherSpanFromCall(
              call,
              completedAt,
              output,
              parsed,
              Number.isFinite(item.durationMs) ? Number(item.durationMs) : null,
              item.exitCode,
            ),
          );
        }
      }
      itemStarts.delete(item.id);
    }
  }

  return {
    spans,
    markers,
    eventCounts,
    thread,
    start,
    end,
    totalRows,
    retainedRows,
    omittedRows,
    truncated,
    window,
  };
}

function launcherDoneMs(record) {
  return toMs(record.launcher?.done_at || record.done_at);
}

function launcherWorkerDetail(record, promptText, eventInfo) {
  const launcher = record.launcher || {};
  const error = record.lastError || launcher.error;
  return [
    "Projectless app-server launcher worker",
    record.workerId ? `Worker ID: ${record.workerId}` : "",
    record.threadId || launcher.thread_id ? `Thread ID: ${record.threadId || launcher.thread_id}` : "",
    record.jobId || launcher.job_id ? `Job ID: ${record.jobId || launcher.job_id}` : "",
    record.status || launcher.status ? `Launcher status: ${record.status || launcher.status}` : "",
    launcher.missing_done_marker ? "Completion marker: missing .codex-worker-launcher/done.json" : "",
    launcher.app_server_pid ? `App-server PID: ${launcher.app_server_pid}` : "",
    launcher.launcher_pid ? `Launcher PID: ${launcher.launcher_pid}` : "",
    launcher.cwd ? `Working directory: ${launcher.cwd}` : "",
    record.projectId ? `Project: ${record.projectId}` : "",
    record.promptFile ? `Prompt file: ${record.promptFile}` : "",
    record.workerConfig ? `Worker config: ${record.workerConfig}` : "",
    launcher.ready_file ? `Ready file: ${launcher.ready_file}` : "",
    launcher.status_file ? `Status file: ${launcher.status_file}` : "",
    launcher.done_file ? `Done file: ${launcher.done_file}` : "",
    launcher.events_file ? `Events file: ${launcher.events_file}` : "",
    eventInfo?.totalRows != null
      ? `Launcher event rows: ${eventInfo.retainedRows ?? eventInfo.totalRows}/${eventInfo.totalRows}${
          eventInfo.truncated ? " (latest rows; older rows omitted)" : ""
        }`
      : "",
    error ? `Error:\n${safeJson(error)}` : "",
    promptText ? `Prompt:\n${promptText}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function launcherWorkerSessions(records, parentId, options = {}) {
  const result = [];
  for (let record of records.values()) {
    record = launcherWorkerWithDoneFile(record);
    const launcher = record.launcher || {};
    const threadId = record.threadId || launcher.thread_id || "";
    const workerId = record.workerId || launcher.worker_id || threadId || "app-server worker";
    const eventsFile = launcher.events_file || "";
    const eventInfo = parseLauncherEvents(eventsFile, options);
    const promptText = readOptionalText(record.promptFile);
    const doneMs = launcherDoneMs(record);
    const markers = [...eventInfo.markers];
    const spans = [...eventInfo.spans];

    const firstObserved = record.createdAt || eventInfo.start || record.observedAt || doneMs;
    const lastObserved = doneMs || eventInfo.end || record.updatedAt || record.observedAt || firstObserved;
    if (!Number.isFinite(firstObserved) || !Number.isFinite(lastObserved)) continue;

    markers.push(
      appThreadMarker(
        firstObserved,
        "app worker observed",
        launcherWorkerDetail(record, promptText, eventInfo),
      ),
    );

    if (doneMs) {
      markers.push(
        appThreadMarker(
          doneMs,
          `app worker ${record.status || launcher.status || "finished"}`,
          launcherWorkerDetail(record, promptText, eventInfo),
        ),
      );
    }

    if (!spans.length && lastObserved > firstObserved) {
      spans.push({
        id: `${threadId || workerId}:launcher`,
        type: record.status === "failed" || launcher.status === "failed" ? "spawn" : "tool",
        name: "app_server_launcher",
        label: record.status === "failed" || launcher.status === "failed" ? "launcher failed" : "worker turn",
        start: firstObserved,
        end: lastObserved,
        durationMs: Math.max(1, lastObserved - firstObserved),
        wallMs: null,
        exitCode: null,
        detail: clipSpanDetail(launcherWorkerDetail(record, promptText, eventInfo)),
      });
    }

    const points = [
      firstObserved,
      lastObserved,
      ...spans.flatMap((span) => [span.start, span.end]),
      ...markers.map((marker) => marker.ts),
    ].filter(Number.isFinite);
    if (!points.length) continue;

    const start = Math.min(...points);
    const end = Math.max(...points);
    const elapsedMs = Math.max(0, end - start);
    const waitMs = unionMs(spans.filter((s) => s.type === "wait"));
    const toolMs = unionMs(spans.filter((s) => s.type !== "wait"));
    const busyMs = unionMs(spans);

    result.push({
      id: threadId || `launcher-worker:${workerId}`,
      title: workerId,
      updatedAt: end ? new Date(end).toISOString() : null,
      filePath: eventsFile || launcher.done_file || "app_server_launcher worker metadata",
      meta: {
        id: threadId || `launcher-worker:${workerId}`,
        parentThreadId: parentId || null,
        cwd: launcher.cwd || eventInfo.thread?.cwd || "",
        source: {
          app_server: {
            thread_id: threadId,
            worker_id: workerId,
            job_id: record.jobId || launcher.job_id || "",
            project_id: record.projectId || "",
            created_via: "codex_security_queue app_server_launcher",
            launcher_status: record.status || launcher.status || "",
            missing_done_marker: Boolean(launcher.missing_done_marker),
            app_server_pid: launcher.app_server_pid || null,
            launcher_pid: launcher.launcher_pid || null,
            prompt_file: record.promptFile || "",
            worker_config: record.workerConfig || "",
            ready_file: launcher.ready_file || "",
            status_file: launcher.status_file || "",
            events_file: eventsFile,
            done_file: launcher.done_file || "",
            prompt: promptText,
            event_rows: eventInfo.totalRows,
            event_rows_loaded: eventInfo.retainedRows ?? eventInfo.totalRows,
            event_rows_omitted: eventInfo.omittedRows || 0,
            event_rows_truncated: eventInfo.truncated,
            event_rows_window: eventInfo.window || "all",
          },
        },
        threadSource: "app_server",
        originator: "app_server_launcher",
        agentNickname: workerId,
        agentRole: "app worker",
      },
      start,
      end,
      elapsedMs,
      metrics: {
        waitMs,
        toolMs,
        quietMs: Math.max(0, elapsedMs - busyMs),
        busyMs,
        spanCount: spans.length,
        eventCount: eventInfo.totalRows || markers.length,
      },
      eventCounts: eventInfo.eventCounts || {},
      spans,
      markers: normalizedMarkers(markers.filter((marker) => marker.ts)),
      spawned: [],
      namespaces: [],
      appServerThread: true,
    });
  }

  return result.sort((a, b) => clampNumber(a.start) - clampNumber(b.start));
}

function normalizedMarkers(markers) {
  const result = [];
  for (const marker of markers.sort((a, b) => clampNumber(a.ts) - clampNumber(b.ts))) {
    if (marker.type === "compact") {
      const previous = result[result.length - 1];
      if (
        previous?.type === "compact" &&
        Math.abs(clampNumber(marker.ts) - clampNumber(previous.ts)) <= COMPACTION_DEDUPE_WINDOW_MS
      ) {
        continue;
      }
    }
    result.push(marker);
  }
  return result;
}

function unionMs(intervals) {
  const sorted = intervals
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let current = null;
  for (const interval of sorted) {
    if (!current) {
      current = { start: interval.start, end: interval.end };
    } else if (interval.start <= current.end) {
      current.end = Math.max(current.end, interval.end);
    } else {
      total += current.end - current.start;
      current = { start: interval.start, end: interval.end };
    }
  }
  if (current) total += current.end - current.start;
  return total;
}

function parseSessionRows(rows, filePath, indexEntry, options = {}) {
  const toolCalls = new Map();
  const terminalSessions = new Map();
  const spans = [];
  const markers = [];
  const spawned = [];
  const appThreads = new Map();
  const launcherWorkers = new Map();
  const launcherHints = new Map();
  const namespaces = new Set();
  const eventCounts = {};
  let meta = {};
  let start = null;
  let end = null;

  for (const row of rows) {
    const ts = toMs(row.timestamp);
    if (ts) {
      start = start == null ? ts : Math.min(start, ts);
      end = end == null ? ts : Math.max(end, ts);
    }
    const payload = row.payload || {};
    const payloadType = payload.type || "";
    const key = [row.type, payloadType, payload.name].filter(Boolean).join("/");
    eventCounts[key] = (eventCounts[key] || 0) + 1;

    const boundaryReason = openToolCallBoundaryReason(row, payloadType, payload);
    if (boundaryReason) {
      closeInterruptedToolCalls(toolCalls, terminalSessions, spans, ts, boundaryReason, launcherHints);
    }

    if (row.type === "session_meta" && !meta.id) {
      meta = {
        id: payload.id,
        parentThreadId: payload.parent_thread_id || null,
        cwd: payload.cwd || "",
        source: payload.source || "",
        threadSource: payload.thread_source || "",
        originator: payload.originator || "",
        cliVersion: payload.cli_version || "",
        agentNickname: payload.agent_nickname || "",
        agentRole: payload.agent_role || "",
        modelProvider: payload.model_provider || "",
        model: payload.model || "",
      };
      if (payload.timestamp) {
        const metaMs = toMs(payload.timestamp);
        if (metaMs) start = start == null ? metaMs : Math.min(start, metaMs);
      }
    }

    if (payloadType === "user_message") {
      markers.push(makeMarker(ts, "user", "user prompt", payload));
    } else if (payloadType === "agent_message") {
      markers.push(makeMarker(ts, "assistant", payload.phase || "assistant", payload));
    } else if (payloadType === "task_started") {
      markers.push(makeMarker(ts, "task", "task started", payload));
    } else if (payloadType === "turn_aborted") {
      markers.push(makeMarker(ts, "abort", "turn aborted", payload));
    } else if (payloadType === "thread_goal_updated") {
      markers.push(makeMarker(ts, "goal", payload.goal?.status || "goal", payload));
    } else if (row.type === "compacted" || payloadType === "context_compacted") {
      markers.push(makeMarker(ts, "compact", "compacted", payload));
    }

    const isCall =
      payloadType === "function_call" ||
      payloadType === "custom_tool_call" ||
      payloadType === "tool_search_call";
    const isOutput =
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call_output" ||
      payloadType === "tool_search_output";

    if (isCall) {
      const callId = payload.call_id || payload.id || `${payload.name || payloadType}-${ts}`;
      const args = parseArgs(payload.arguments);
      if (args.namespace) namespaces.add(args.namespace);
      if (payload.namespace) namespaces.add(payload.namespace);
      toolCalls.set(callId, {
        callId,
        name: payload.name || payloadType,
        namespace: payload.namespace || "",
        start: ts,
        args,
      });
    } else if (isOutput) {
      const callId = payload.call_id || payload.id;
      const call = callId ? toolCalls.get(callId) : null;
      if (!call || !ts || !call.start) continue;
      const wallMs = parseWallMs(payload.output);
      const exitCode = parseExitCode(payload.output);
      const parsed = extractToolJson(payload.output);
      collectLauncherHintsFromCall(call, launcherHints, ts);
      collectLauncherWorkersFromParsed(parsed, launcherWorkers, ts);
      const displayCall = semanticToolCall(call, terminalSessions);
      const type = toolSpanType(displayCall.name, wallMs);
      const label = summarizeTool(displayCall.name, displayCall.args);
      const durationMs = ts - call.start;
      spans.push({
        id: displayCall.callId,
        type,
        name: displayCall.name,
        label,
        start: displayCall.start,
        end: ts,
        durationMs,
        wallMs,
        exitCode,
        waitTarget: type === "wait" ? waitTargetSummary(displayCall.name, displayCall.args) : "",
        argsPreview: toolArgsPreview(displayCall),
        outputPreview: clipSpanDetail(parsedOutputSummary(parsed) || outputPayloadText(payload.output)),
        detail: spanDetail(displayCall, type, durationMs, wallMs, exitCode, parsed, payload.output),
      });

      if (call.name === "exec_command" && type === "wait") {
        for (const sessionId of terminalSessionIdsFromOutput(payload.output)) {
          terminalSessions.set(sessionId, displayCall);
        }
      }
      toolCalls.delete(callId);

      if (call.name === "spawn_agent") {
        if (parsed && parsed.agent_id) {
          spawned.push({
            id: parsed.agent_id,
            nickname: parsed.nickname || "",
            start: call.start,
            end: ts,
            status: "spawned",
          });
        } else {
          spawned.push({
            id: `failed-${call.callId}`,
            nickname: "spawn failed",
            start: call.start,
            end: ts,
            status: "failed",
          });
        }
      }

      if (call.namespace === "codex_app" && call.name === "create_thread" && parsed?.threadId) {
        const record = ensureAppThreadRecord(appThreads, parsed.threadId);
        if (record) {
          record.create = {
            callId: call.callId,
            start: call.start,
            end: ts,
          };
          record.prompt = call.args?.prompt || record.prompt || "";
          record.projectId = call.args?.target?.projectId || record.projectId || "";
          record.thinking = call.args?.thinking || record.thinking || "";
        }
      }

      if (call.namespace === "codex_app" && call.name === "read_thread" && parsed?.thread?.id) {
        const record = ensureAppThreadRecord(appThreads, parsed.thread.id);
        if (record) {
          record.reads.push({
            callId: call.callId,
            readAt: ts,
            args: call.args || {},
            thread: parsed.thread || {},
            turns: Array.isArray(parsed.turns) ? parsed.turns : [],
          });
        }
      }

      if (call.namespace === "codex_app" && call.name === "set_thread_archived" && call.args?.threadId) {
        const record = ensureAppThreadRecord(appThreads, call.args.threadId);
        if (record) {
          record.archives.push({
            callId: call.callId,
            ts,
            archived: call.args.archived,
          });
        }
      }

      const ns = collectNamespaces(parsed);
      for (const namespace of ns) namespaces.add(namespace);
    }
  }

  const activeEnd = Date.now();
  for (const call of toolCalls.values()) {
    if (!Number.isFinite(call.start) || call.start > activeEnd) continue;
    const displayCall = semanticToolCall(call, terminalSessions);
    collectLauncherHintsFromCall(displayCall, launcherHints, activeEnd);
    const type = toolSpanType(displayCall.name, null);
    const label = summarizeTool(displayCall.name, displayCall.args);
    const durationMs = Math.max(1, activeEnd - call.start);
    const endMs = call.start + durationMs;
    spans.push({
      id: displayCall.callId,
      type,
      status: "running",
      active: true,
      name: displayCall.name,
      label,
      args: displayCall.args || {},
      start: displayCall.start,
      end: endMs,
      durationMs,
      wallMs: null,
      exitCode: null,
      waitTarget: type === "wait" ? waitTargetSummary(displayCall.name, displayCall.args) : "",
      argsPreview: toolArgsPreview(displayCall),
      outputPreview: "",
      detail: runningSpanDetail(displayCall, type, durationMs),
    });
    end = end == null ? endMs : Math.max(end, endMs);
  }

  const activeSpanMs = start && end ? Math.max(0, end - start) : 0;
  const waitMs = unionMs(spans.filter((s) => s.type === "wait"));
  const toolMs = unionMs(spans.filter((s) => s.type !== "wait"));
  const busyMs = unionMs(spans);
  const quietMs = Math.max(0, activeSpanMs - busyMs);
  collectLauncherWorkersFromHints(launcherHints, launcherWorkers);

  return {
    id: meta.id || indexEntry?.id || path.basename(filePath),
    title: indexEntry?.thread_name || indexEntry?.title || "",
    updatedAt: indexEntry?.updated_at || null,
    filePath,
    meta,
    start,
    end,
    elapsedMs: activeSpanMs,
    metrics: {
      waitMs,
      toolMs,
      quietMs,
      busyMs,
      spanCount: spans.length,
      eventCount: rows.length,
    },
    eventCounts,
    spans,
    markers: normalizedMarkers(markers.filter((m) => m.ts)),
    spawned,
    namespaces: [...namespaces],
    appThreads: mergedAppThreadSessions([
      ...appThreadSessions(appThreads, meta.id || indexEntry?.id || path.basename(filePath)),
      ...launcherWorkerSessions(launcherWorkers, meta.id || indexEntry?.id || path.basename(filePath), options),
    ]),
  };
}

function parseSessionFile(filePath, indexEntry, options = {}) {
  return parseSessionRows(readJsonl(filePath), filePath, indexEntry, options);
}

function collectNamespaces(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  if (typeof value.namespace === "string") result.add(value.namespace);
  if (value.namespace && typeof value.namespace.namespace === "string") {
    result.add(value.namespace.namespace);
  }
  if (Array.isArray(value.queues)) {
    for (const q of value.queues) collectNamespaces(q, result);
  }
  if (Array.isArray(value.items)) {
    for (const item of value.items) collectNamespaces(item, result);
  }
  if (value.queue) collectNamespaces(value.queue, result);
  return result;
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function sqliteJson(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  const runSqlite = (queryPath) => {
    const out = execFileSync("sqlite3", ["-json", queryPath, sql], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out ? JSON.parse(out) : [];
  };
  try {
    return runSqlite(dbPath);
  } catch (err) {
    const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8") : String(err.stderr || "");
    const message = `${err.message || ""}\n${stderr}`;
    if (!message.includes("unable to open database file")) {
      throw new Error(`sqlite3 failed for ${path.basename(dbPath)}: ${err.message}`);
    }
    try {
      fs.mkdirSync(SQLITE_COPY_DIR, { recursive: true });
      const stat = fs.statSync(dbPath);
      const digest = crypto
        .createHash("sha1")
        .update(`${dbPath}\0${stat.size}\0${stat.mtimeMs}`)
        .digest("hex")
        .slice(0, 16);
      const copyPath = path.join(SQLITE_COPY_DIR, `${path.basename(dbPath)}.${digest}.sqlite`);
      fs.copyFileSync(dbPath, copyPath);
      return runSqlite(copyPath);
    } catch (copyErr) {
      throw new Error(
        `sqlite3 failed for ${path.basename(dbPath)} and temp-copy fallback failed: ${copyErr.message}`,
      );
    }
  }
}

function idempotencyLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/^(.+):([^:]+)$/);
  return match ? `${match[1]} #${match[2]}` : text;
}

function parsePayloadLabel(payload, fallback, idempotencyKey = "", queueName = "") {
  if (!payload || typeof payload !== "object") return fallback;
  const itemNumber = payload.item_number ?? payload.itemNumber ?? payload.number;
  if (itemNumber != null && itemNumber !== "") {
    const prefix = queueName ? `${queueName} #${itemNumber}` : `item #${itemNumber}`;
    return payload.topic ? `${prefix}: ${payload.topic}` : prefix;
  }
  return (
    payload.assigned_path ||
    payload.path ||
    payload.file ||
    payload.unit_id ||
    payload.item_id ||
    payload.itemId ||
    payload.candidate_id ||
    payload.candidateId ||
    payload.row?.path ||
    payload.row?.file ||
    payload.task ||
    payload.name ||
    payload.title ||
    idempotencyLabel(idempotencyKey) ||
    fallback
  );
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function queueWorkerId(leaseOwner, payload, result) {
  return firstString(
    leaseOwner,
    result?.worker_id,
    result?.workerId,
    result?.worker,
    payload?.worker_id,
    payload?.workerId,
    payload?.worker,
  );
}

function queueWorkerItemDetail(item, workerId) {
  return [
    `Worker ID: ${workerId}`,
    `Queue: ${item.queueName}`,
    `Namespace: ${item.namespace}`,
    `Item: ${item.label} (${item.id})`,
    `Status: ${item.status}`,
    `Created: ${item.created ? new Date(item.created).toISOString() : "unknown"}`,
    item.updated ? `Updated: ${new Date(item.updated).toISOString()}` : "",
    item.completed ? `Completed: ${new Date(item.completed).toISOString()}` : "",
    item.leaseExpires ? `Lease expires: ${new Date(item.leaseExpires).toISOString()}` : "",
    `Queue latency: ${formatDurationMs(item.latencyMs || 0)}`,
    `Attempts: ${item.attempts || 0}/${item.maxAttempts || 0}`,
    item.instructions ? `Instructions:\n${item.instructions}` : "",
    item.payloadPreview ? `Payload:\n${item.payloadPreview}` : "",
    item.resultPreview ? `Result:\n${item.resultPreview}` : "",
    item.error ? `Error: ${item.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function queueWorkerSessions(items, queues = []) {
  const queueInstructions = new Map(
    (queues || []).map((queue) => [`${queue.namespace}\0${queue.name}`, queue.instructions || ""]),
  );
  const groups = new Map();
  for (const item of items || []) {
    const workerId = item.workerId || item.leaseOwner;
    if (!workerId) continue;
    const key = `${item.namespace}\0${workerId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        workerId,
        namespace: item.namespace,
        queues: new Set(),
        items: [],
      });
    }
    const group = groups.get(key);
    group.queues.add(item.queueName);
    group.items.push(item);
  }

  const sessions = [];
  for (const group of groups.values()) {
    const counts = group.items.reduce(
      (acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        acc.total += 1;
        return acc;
      },
      { total: 0, queued: 0, leased: 0, completed: 0, failed: 0 },
    );
    const firstCreated = Math.min(...group.items.map((item) => item.created).filter(Number.isFinite));
    const queueInstructionText = firstString(
      ...group.items.map((item) => item.instructions),
      ...[...group.queues].map((queueName) => queueInstructions.get(`${group.namespace}\0${queueName}`)),
    );
    const itemSamples = group.items
      .slice()
      .sort((a, b) => {
        const aTs = a.completed || a.updated || a.end || a.created || 0;
        const bTs = b.completed || b.updated || b.end || b.created || 0;
        return aTs - bTs;
      })
      .slice(0, 5)
      .map((item) => ({
        id: item.id,
        queueName: item.queueName,
        label: item.label,
        status: item.status,
        created: item.created,
        updated: item.updated,
        completed: item.completed,
        latencyMs: item.latencyMs,
        instructions: item.instructions,
        payloadPreview: item.payloadPreview,
        resultPreview: item.resultPreview,
      }));
    const markers = [];
    const spans = [];
    for (const item of group.items) {
      const ts = item.completed || item.updated || item.end || item.created;
      if (ts) {
        const markerType =
          item.status === "failed"
            ? "queue_failed"
            : item.status === "leased"
              ? "queue_leased"
              : item.status === "completed"
                ? "queue_completed"
                : "queue_item";
        markers.push({
          type: markerType,
          ts,
          label: `${item.queueName}: ${item.label}`,
          detail: queueWorkerItemDetail(item, group.workerId),
        });
      }
      if (item.status === "leased" && item.updated && item.end && item.end > item.updated) {
        spans.push({
          type: "leased",
          label: `${item.queueName}: ${item.label}`,
          start: item.updated,
          end: item.end,
          durationMs: Math.max(0, item.end - item.updated),
          detail: queueWorkerItemDetail(item, group.workerId),
          active: true,
          status: "running",
        });
      }
    }

    const points = [
      ...markers.map((marker) => marker.ts),
      ...spans.flatMap((span) => [span.start, span.end]),
    ].filter(Number.isFinite);
    if (!points.length) continue;

    const start = Math.min(...points);
    const end = Math.max(...points);
    const elapsedMs = Math.max(0, end - start);
    const busyMs = unionMs(spans);
    sessions.push({
      id: `queue-worker:${group.namespace}:${group.workerId}`,
      title: group.workerId,
      updatedAt: end ? new Date(end).toISOString() : null,
      filePath: "Queue Service item records",
      meta: {
        source: {
          queue_worker: {
            worker_id: group.workerId,
            namespace: group.namespace,
            queues: [...group.queues],
            counts,
            first_item_created: Number.isFinite(firstCreated) ? firstCreated : null,
            first_observed_activity: start,
            last_observed_activity: end,
            queue_instructions: queueInstructionText,
            item_samples: itemSamples,
            transcript_status:
              "This queue worker is inferred from Queue Service item records. It is not a Codex child session, so no per-worker prompt/tool transcript was captured.",
            timing_source:
              "Derived from Queue Service item lease_owner and result.worker_id fields.",
          },
        },
        threadSource: "queue_worker",
        originator: "queue-service",
        agentNickname: group.workerId,
        agentRole: "queue worker",
      },
      start,
      end,
      elapsedMs,
      metrics: {
        waitMs: 0,
        toolMs: busyMs,
        quietMs: Math.max(0, elapsedMs - busyMs),
        busyMs,
        spanCount: spans.length,
        eventCount: markers.length,
      },
      eventCounts: {},
      spans,
      markers: normalizedMarkers(markers),
      spawned: [],
      namespaces: [group.namespace],
      queueWorker: true,
    });
  }

  return sessions.sort((a, b) => clampNumber(a.start) - clampNumber(b.start));
}

function emptyQueueStats() {
  return {
    total: 0,
    queued: 0,
    leased: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    completedLatencyMs: 0,
    completedLatencyCount: 0,
    avgCompletedLatencyMs: 0,
    findingsTotal: 0,
  };
}

function emptyQueueCounts() {
  return { total: 0, queued: 0, leased: 0, completed: 0, failed: 0, cancelled: 0 };
}

function queueItemEndMs(item, now) {
  const completed = toMs(item.completed_at);
  const updated = toMs(item.updated_at);
  if (completed) return completed;
  if (item.status === "leased") return now;
  return updated || toMs(item.created_at) || now;
}

function normalizeQueueTimelineRows(rows, now) {
  return (rows || [])
    .map((item) => {
      const created = toMs(item.created_at);
      const end = queueItemEndMs(item, now);
      return {
        namespace: item.namespace,
        queueName: item.queue_name,
        status: item.status,
        created,
        end,
        completed: toMs(item.completed_at),
      };
    })
    .filter((item) => Number.isFinite(item.created) && Number.isFinite(item.end));
}

function queueStatsFromCounts(countRows, timelineItems) {
  const stats = emptyQueueStats();
  for (const row of countRows || []) {
    const count = Number(row.count || row["count(*)"] || 0);
    const status = row.status || "";
    stats.total += count;
    if (status) stats[status] = (stats[status] || 0) + count;
  }

  for (const item of timelineItems || []) {
    if (item.status !== "completed") continue;
    stats.completedLatencyMs += Math.max(0, item.end - item.created);
    stats.completedLatencyCount += 1;
  }
  stats.avgCompletedLatencyMs = stats.completedLatencyCount
    ? Math.round(stats.completedLatencyMs / stats.completedLatencyCount)
    : 0;
  return stats;
}

function queueCountsFor(countRows, namespace, queueName) {
  const counts = emptyQueueCounts();
  for (const row of countRows || []) {
    if (row.namespace !== namespace || row.queue_name !== queueName) continue;
    const count = Number(row.count || row["count(*)"] || 0);
    const status = row.status || "";
    counts.total += count;
    if (status) counts[status] = (counts[status] || 0) + count;
  }
  return counts;
}

function uniqueRowsById(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    if (!row?.id || byId.has(row.id)) continue;
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

function queueItemDetailQueries(inList) {
  const limit = Math.max(1, Math.ceil(MAX_QUEUE_ITEMS / 5));
  const activeLimit = Math.max(1, Math.ceil(MAX_QUEUE_ITEMS / 3));
  const columns = `SELECT id, namespace, queue_name, status, priority, attempts, max_attempts,
              lease_owner, lease_expires_at, created_at, updated_at, completed_at,
              instructions, idempotency_key, payload_json, result_json, error
       FROM items
       WHERE namespace IN (${inList})`;
  return [
    `${columns} AND status IN ('leased', 'failed') ORDER BY updated_at DESC, created_at DESC LIMIT ${activeLimit}`,
    `${columns} AND status = 'queued' ORDER BY created_at ASC LIMIT ${limit}`,
    `${columns} AND status = 'completed' ORDER BY completed_at DESC, updated_at DESC LIMIT ${limit}`,
    `${columns} ORDER BY created_at DESC LIMIT ${limit}`,
    `${columns} ORDER BY
       (julianday(COALESCE(completed_at, updated_at, created_at)) - julianday(created_at)) DESC,
       updated_at DESC
       LIMIT ${limit}`,
  ];
}

function codexSecurityStatus(status) {
  if (status === "pending") return "queued";
  return status || "";
}

function codexSecurityQueueHintsFromAppThreads(appThreads) {
  const byDb = new Map();
  for (const thread of appThreads || []) {
    const source = thread?.meta?.source?.app_server || {};
    const configPath = source.worker_config || "";
    if (!configPath || !fs.existsSync(configPath)) continue;
    let config = null;
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      continue;
    }
    const dbPath = config?.db || "";
    const jobId = config?.job_id || source.job_id || "";
    if (!dbPath || !jobId) continue;
    if (!byDb.has(dbPath)) byDb.set(dbPath, new Set());
    byDb.get(dbPath).add(jobId);
  }
  return [...byDb.entries()].map(([dbPath, jobIds]) => ({ dbPath, jobIds: [...jobIds] }));
}

function likelyCodexSecurityQueueDb(fileName) {
  return fileName === "queue.db" || /queue.*\.db$/i.test(fileName);
}

function shouldSkipQueueDbDir(dirName) {
  return [
    ".git",
    "node_modules",
    "target",
    "cargo-target",
    "validation-artifacts",
  ].includes(dirName);
}

function walkQueueDbs(rootDir, visitor) {
  if (!rootDir || !fs.existsSync(rootDir)) return;
  const stack = [rootDir];
  let visited = 0;
  while (stack.length && visited < 5000) {
    const current = stack.pop();
    visited += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipQueueDbDir(entry.name)) stack.push(fullPath);
      } else if (entry.isFile() && likelyCodexSecurityQueueDb(entry.name)) {
        visitor(fullPath);
      }
    }
  }
}

function codexSecurityQueueDbRoots(codexHome = CODEX_HOME) {
  return [
    path.join(os.homedir(), ".cache", "codex-security"),
    path.join(codexHome || CODEX_HOME, "state", "plugins", "codex-security"),
  ];
}

function discoverCodexSecurityQueueDbs(codexHome = CODEX_HOME) {
  const paths = new Set();
  for (const root of codexSecurityQueueDbRoots(codexHome)) {
    walkQueueDbs(root, (dbPath) => paths.add(dbPath));
  }
  return [...paths].sort();
}

function codexSecurityQueueHintsFromParentThread(sessionId, codexHome = CODEX_HOME) {
  const byDb = new Map();
  for (const dbPath of discoverCodexSecurityQueueDbs(codexHome)) {
    try {
      const tables = sqliteJson(
        dbPath,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'work_items')",
      );
      if (tables.length < 2) continue;
      const jobs = sqliteJson(
        dbPath,
        `SELECT id FROM jobs WHERE parent_thread_id = '${sqlEscape(sessionId)}' ORDER BY updated_at DESC`,
      );
      const jobIds = jobs.map((job) => job.id).filter(Boolean);
      if (!jobIds.length) continue;
      if (!byDb.has(dbPath)) byDb.set(dbPath, new Set());
      for (const jobId of jobIds) byDb.get(dbPath).add(jobId);
    } catch {
      // Ignore non-matching or transiently locked queue DBs.
    }
  }
  return [...byDb.entries()].map(([dbPath, jobIds]) => ({ dbPath, jobIds: [...jobIds] }));
}

function mergeCodexSecurityQueueHints(hints) {
  const byDb = new Map();
  for (const hint of hints || []) {
    const dbPath = hint?.dbPath || "";
    if (!dbPath) continue;
    if (!byDb.has(dbPath)) byDb.set(dbPath, new Set());
    for (const jobId of hint.jobIds || []) {
      if (jobId) byDb.get(dbPath).add(jobId);
    }
  }
  return [...byDb.entries()].map(([dbPath, jobIds]) => ({ dbPath, jobIds: [...jobIds] }));
}

function codexSecurityScanKeyFromDbPath(dbPath) {
  const parts = String(dbPath || "").split(path.sep).filter(Boolean);
  const queueRootIndex = parts.findIndex((part) => /-queues$/i.test(part));
  if (queueRootIndex >= 0 && parts[queueRootIndex + 1] && parts[queueRootIndex + 2]) {
    return `${parts[queueRootIndex + 1]}/${parts[queueRootIndex + 2]}`;
  }

  const scansIndex = parts.lastIndexOf("scans");
  if (scansIndex >= 0 && parts[scansIndex + 1] && parts[scansIndex + 2]) {
    return `${parts[scansIndex + 1]}/${String(parts[scansIndex + 2]).split("_")[0]}`;
  }

  return "";
}

function isoFromAppTimestamp(value) {
  const ms = appTimestampMs(value);
  return ms ? new Date(ms).toISOString() : "";
}

function codexSecurityJobHeartbeatStale(job, now = Date.now()) {
  const status = String(job?.status || "");
  if (status !== "running" && status !== "pending") return false;
  const heartbeatMs = appTimestampMs(job?.parent_heartbeat_at);
  const staleSeconds = Number(job?.parent_stale_seconds || 0);
  return Boolean(heartbeatMs && staleSeconds > 0 && now - heartbeatMs > staleSeconds * 1000);
}

function codexSecurityQueueLinkStatus(job, sessionId) {
  const parentThreadId = job?.parent_thread_id || "";
  if (sessionId && parentThreadId === sessionId) return "linked";
  if (!parentThreadId) return "unlinked";
  return "other-session";
}

function codexSecurityQueueSummary(job, countRows, workerRows, dbPath, sessionId, extra = {}) {
  const counts = queueCountsFor(countRows, job.id, job.id);
  const now = Date.now();
  const linkStatus = codexSecurityQueueLinkStatus(job, sessionId);
  return {
    namespace: job.id,
    name: job.id,
    description: job.name || "Codex Security queue job",
    instructions: job.name || "",
    createdAt: isoFromAppTimestamp(job.created_at),
    updatedAt: isoFromAppTimestamp(job.updated_at),
    lastActivityAt: isoFromAppTimestamp(job.updated_at),
    lastEnqueuedAt: "",
    lastClaimedAt: "",
    lastCompletedAt: isoFromAppTimestamp(job.completed_at),
    status: job.status || "",
    counts,
    sampleRowsLoaded: extra.sampleRowsLoaded || 0,
    source: "codex-security",
    dbPath,
    workerCount: workerRows.filter((worker) => worker.job_id === job.id).length,
    parentThreadId: job.parent_thread_id || "",
    linkedToSession: linkStatus === "linked",
    linkStatus,
    parentHeartbeatAt: isoFromAppTimestamp(job.parent_heartbeat_at),
    parentStaleSeconds: Number(job.parent_stale_seconds || 0),
    heartbeatStale: codexSecurityJobHeartbeatStale(job, now),
    detached: Boolean(Number(job.detached || 0)),
    diagnosticReason: extra.diagnosticReason || "",
  };
}

function launcherWorkerRecordsFromWorkerRows(workerRows) {
  const records = new Map();
  for (const row of workerRows || []) {
    let metadata = {};
    try {
      metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    } catch {
      metadata = {};
    }
    mergeLauncherWorkerRecord(
      records,
      {
        worker_id: row.worker_id || "",
        thread_id: row.thread_id || "",
        job_id: row.job_id || "",
        status: row.status || "",
        created_at: row.created_at,
        updated_at: row.updated_at || row.last_queue_action_at || row.last_observed_at,
        last_observed_at: row.last_observed_at,
        last_queue_action_at: row.last_queue_action_at,
        last_error: row.last_error || "",
        metadata,
      },
      appTimestampMs(row.updated_at || row.last_queue_action_at || row.last_observed_at || row.created_at),
    );
  }
  return records;
}

function codexSecurityActiveDiagnosticQueuesFromDb(dbPath, sessionId, linkedJobKeys) {
  const warnings = [];
  let jobs = [];
  let countRows = [];
  let workerRows = [];
  try {
    const tables = sqliteJson(
      dbPath,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'work_items')",
    );
    if (tables.length < 2) return { queues: [], warnings };
    jobs = sqliteJson(
      dbPath,
      `SELECT id, name, status, input_path, output_path, max_attempts, lease_ttl_seconds,
              created_at, updated_at, completed_at, last_error, no_new_leases,
              cancel_requested_at, cancel_reason, parent_heartbeat_at, parent_thread_id,
              parent_stale_seconds, detached
       FROM jobs ORDER BY updated_at DESC`,
    );
    if (!jobs.length) return { queues: [], warnings };
    const jobFilter = jobs.map((job) => `'${sqlEscape(job.id)}'`).join(",");
    countRows = sqliteJson(
      dbPath,
      `SELECT job_id AS namespace, job_id AS queue_name,
              CASE status WHEN 'pending' THEN 'queued' ELSE status END AS status,
              COUNT(*) AS count
       FROM work_items
       WHERE job_id IN (${jobFilter})
       GROUP BY job_id, status`,
    );
    workerRows = sqliteJson(
      dbPath,
      `SELECT job_id, worker_id, thread_id, status, metadata_json, created_at, updated_at,
              last_observed_at, last_queue_action_at, last_error
       FROM worker_runs
       WHERE job_id IN (${jobFilter})
       ORDER BY job_id, worker_id`,
    );
  } catch (err) {
    warnings.push(err.message);
    return { queues: [], warnings };
  }

  const queues = [];
  for (const job of jobs) {
    const linkedKey = `${dbPath}\0${job.id}`;
    if (linkedJobKeys.has(linkedKey)) continue;
    if (sessionId && job.parent_thread_id === sessionId) continue;

    const counts = queueCountsFor(countRows, job.id, job.id);
    const activeItems = Number(counts.queued || 0) + Number(counts.leased || 0);
    const stale = codexSecurityJobHeartbeatStale(job);
    const jobActive = job.status === "running" || job.status === "pending";
    if (!activeItems && !jobActive && !stale) continue;

    queues.push(
      codexSecurityQueueSummary(job, countRows, workerRows, dbPath, sessionId, {
        diagnosticReason: stale
          ? "Unlinked stale/running queue in this scan root"
          : "Unlinked active queue in this scan root",
      }),
    );
  }
  return { queues, warnings };
}

function discoverRelatedCodexSecurityDiagnostics(sessionId, hints, codexHome = CODEX_HOME) {
  const scanKeys = new Set((hints || []).map((hint) => codexSecurityScanKeyFromDbPath(hint.dbPath)).filter(Boolean));
  if (!scanKeys.size) return { queues: [], warnings: [] };

  const linkedJobKeys = new Set();
  for (const hint of hints || []) {
    for (const jobId of hint.jobIds || []) {
      linkedJobKeys.add(`${hint.dbPath}\0${jobId}`);
    }
  }

  const queues = [];
  const warnings = [];
  for (const dbPath of discoverCodexSecurityQueueDbs(codexHome)) {
    if (!scanKeys.has(codexSecurityScanKeyFromDbPath(dbPath))) continue;
    const result = codexSecurityActiveDiagnosticQueuesFromDb(dbPath, sessionId, linkedJobKeys);
    queues.push(...result.queues);
    warnings.push(...result.warnings);
  }

  return {
    queues: queues.sort((a, b) => {
      const activeA = Number(a.counts?.queued || 0) + Number(a.counts?.leased || 0);
      const activeB = Number(b.counts?.queued || 0) + Number(b.counts?.leased || 0);
      if (activeA !== activeB) return activeB - activeA;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    }),
    warnings,
  };
}

function codexSecurityItemRows(dbPath, jobFilter) {
  const baseColumns = `SELECT id, job_id, item_key, input_json, status, attempt_count,
              lease_id, worker_id, lease_expires_at, result_json, last_error,
              created_at, updated_at, completed_at
       FROM work_items
       WHERE job_id IN (${jobFilter})`;
  const limit = Math.max(1, Math.ceil(MAX_QUEUE_ITEMS / 5));
  const activeLimit = Math.max(1, Math.ceil(MAX_QUEUE_ITEMS / 3));
  return uniqueRowsById(
    [
      `${baseColumns} AND status IN ('leased', 'failed', 'cancelled') ORDER BY updated_at DESC, created_at DESC LIMIT ${activeLimit}`,
      `${baseColumns} AND status = 'pending' ORDER BY created_at ASC LIMIT ${limit}`,
      `${baseColumns} AND status = 'completed' ORDER BY completed_at DESC, updated_at DESC LIMIT ${limit}`,
      `${baseColumns} ORDER BY created_at DESC LIMIT ${limit}`,
      `${baseColumns} ORDER BY COALESCE(completed_at, updated_at, created_at) - created_at DESC, updated_at DESC LIMIT ${limit}`,
    ].flatMap((query) => sqliteJson(dbPath, query)),
  ).slice(0, MAX_QUEUE_ITEMS);
}

function loadCodexSecurityQueueDataFromDb(dbPath, jobIds, options = {}) {
  const warnings = [];
  if (!fs.existsSync(dbPath)) {
    return emptyQueue(dbPath, [`Codex Security queue DB not found at ${dbPath}`]);
  }
  const jobsFilter = (jobIds || []).filter(Boolean);
  const jobWhere = jobsFilter.length
    ? `WHERE id IN (${jobsFilter.map((id) => `'${sqlEscape(id)}'`).join(",")})`
    : "";
  let jobs = [];
  let countRows = [];
  let timelineRows = [];
  let workerRows = [];
  let itemRows = [];
  try {
    jobs = sqliteJson(
      dbPath,
      `SELECT id, name, status, input_path, output_path, max_attempts, lease_ttl_seconds,
              created_at, updated_at, completed_at, last_error, no_new_leases,
              cancel_requested_at, cancel_reason, parent_heartbeat_at, parent_thread_id,
              parent_stale_seconds, detached
       FROM jobs ${jobWhere} ORDER BY updated_at DESC`,
    );
    if (!jobs.length) {
      return emptyQueue(dbPath, warnings);
    }
    const jobFilter = jobs.map((job) => `'${sqlEscape(job.id)}'`).join(",");
    countRows = sqliteJson(
      dbPath,
      `SELECT job_id AS namespace, job_id AS queue_name,
              CASE status WHEN 'pending' THEN 'queued' ELSE status END AS status,
              COUNT(*) AS count
       FROM work_items
       WHERE job_id IN (${jobFilter})
       GROUP BY job_id, status`,
    );
    timelineRows = sqliteJson(
      dbPath,
      `SELECT job_id AS namespace, job_id AS queue_name,
              CASE status WHEN 'pending' THEN 'queued' ELSE status END AS status,
              created_at, updated_at, completed_at
       FROM work_items
       WHERE job_id IN (${jobFilter})
       ORDER BY created_at ASC, job_id ASC
       LIMIT ${MAX_QUEUE_TIMELINE_ITEMS}`,
    );
    workerRows = sqliteJson(
      dbPath,
      `SELECT job_id, worker_id, thread_id, status, metadata_json, created_at, updated_at,
              last_observed_at, last_queue_action_at, last_error
       FROM worker_runs
       WHERE job_id IN (${jobFilter})
       ORDER BY job_id, worker_id`,
    );
    itemRows = codexSecurityItemRows(dbPath, jobFilter);
  } catch (err) {
    warnings.push(err.message);
  }

  const now = Date.now();
  const timelineItems = (timelineRows || [])
    .map((row) => {
      const created = appTimestampMs(row.created_at);
      const completed = appTimestampMs(row.completed_at);
      const updated = appTimestampMs(row.updated_at);
      const status = codexSecurityStatus(row.status);
      const end = completed || (status === "leased" ? now : updated || created || now);
      return {
        namespace: row.namespace,
        queueName: row.queue_name,
        status,
        created,
        end,
        completed,
      };
    })
    .filter((item) => Number.isFinite(item.created) && Number.isFinite(item.end));
  const stats = queueStatsFromCounts(countRows, timelineItems);
  stats.source = "codex-security";
  stats.workers = workerRows.length;

  const jobById = new Map((jobs || []).map((job) => [job.id, job]));
  const normalizedItems = (itemRows || []).map((item) => {
    let payload = {};
    let result = {};
    try {
      payload = item.input_json ? JSON.parse(item.input_json) : {};
    } catch {
      payload = {};
    }
    try {
      result = item.result_json ? JSON.parse(item.result_json) : {};
    } catch {
      result = {};
    }
    const job = jobById.get(item.job_id) || {};
    const status = codexSecurityStatus(item.status);
    const created = appTimestampMs(item.created_at);
    const updated = appTimestampMs(item.updated_at);
    const completed = appTimestampMs(item.completed_at);
    const leaseExpires = appTimestampMs(item.lease_expires_at);
    const end = completed || (status === "leased" ? now : updated || now);
    const workerId = queueWorkerId(item.worker_id, payload, result);
    return {
      id: item.id,
      namespace: item.job_id,
      queueName: item.job_id,
      status,
      label: parsePayloadLabel(payload, item.item_key || item.id.slice(0, 8), item.item_key, item.job_id),
      idempotencyKey: item.item_key || "",
      leaseOwner: item.worker_id || "",
      workerId,
      instructions: job.name || "",
      payloadPreview: clipText(safeJson(payload), 1200),
      resultPreview: clipText(safeJson(result), 1200),
      attempts: item.attempt_count,
      maxAttempts: job.max_attempts || 0,
      created,
      updated,
      completed,
      leaseExpires,
      end,
      latencyMs: created && end ? Math.max(0, end - created) : 0,
      activeLeaseMs: status === "leased" && updated ? Math.max(0, now - updated) : 0,
      findingsTotal: Number(result.findings_total || 0),
      candidateCount: Number(result.candidate_count || 0),
      error: item.last_error || "",
    };
  });

  const normalizedQueues = (jobs || []).map((job) => {
    const queueItems = normalizedItems.filter((item) => item.queueName === job.id);
    return codexSecurityQueueSummary(job, countRows, workerRows, dbPath, options.sessionId || "", {
      sampleRowsLoaded: queueItems.length,
    });
  });
  const queueTimeline = buildQueueTimeline(timelineItems, normalizedQueues);

  return {
    dbPath,
    dbPaths: [dbPath],
    namespaces: [],
    queues: normalizedQueues,
    workers: queueWorkerSessions(normalizedItems, normalizedQueues),
    appWorkers: launcherWorkerSessions(
      launcherWorkerRecordsFromWorkerRows(workerRows),
      options.sessionId || "",
      options,
    ),
    timeline: queueTimeline,
    items: normalizedItems,
    stats,
    warnings,
    truncated: stats.total > normalizedItems.length,
    itemRowsLoaded: normalizedItems.length,
    itemRowsTotal: stats.total,
    timelineRowsLoaded: timelineItems.length,
    timelineTruncated: stats.total > timelineItems.length,
    source: "codex-security",
  };
}

function mergeQueueStats(parts) {
  const merged = emptyQueueStats();
  for (const stats of parts || []) {
    if (!stats) continue;
    for (const key of ["total", "queued", "leased", "completed", "failed", "cancelled", "findingsTotal"]) {
      merged[key] = (merged[key] || 0) + Number(stats[key] || 0);
    }
    merged.completedLatencyMs += Number(stats.completedLatencyMs || 0);
    merged.completedLatencyCount += Number(stats.completedLatencyCount || 0);
  }
  merged.avgCompletedLatencyMs = merged.completedLatencyCount
    ? Math.round(merged.completedLatencyMs / merged.completedLatencyCount)
    : 0;
  return merged;
}

function mergeQueueData(parts) {
  const filtered = (parts || []).filter(Boolean);
  if (!filtered.length) return emptyQueue(QUEUE_DB);
  const dbPaths = [...new Set(filtered.flatMap((part) => part.dbPaths || [part.dbPath]).filter(Boolean))];
  const queues = filtered.flatMap((part) => part.queues || []);
  const items = filtered.flatMap((part) => part.items || []);
  const timeline = filtered.flatMap((part) => part.timeline || []);
  return {
    dbPath: dbPaths.join(", "),
    dbPaths,
    namespaces: filtered.flatMap((part) => part.namespaces || []),
    queues,
    appWorkers: mergedAppThreadSessions(filtered.flatMap((part) => part.appWorkers || [])),
    workers: queueWorkerSessions(items, queues),
    timeline,
    items,
    unlinkedQueues: filtered.flatMap((part) => part.unlinkedQueues || []),
    stats: mergeQueueStats(filtered.map((part) => part.stats)),
    warnings: filtered.flatMap((part) => part.warnings || []),
    truncated: filtered.some((part) => part.truncated),
    itemRowsLoaded: filtered.reduce((sum, part) => sum + Number(part.itemRowsLoaded || 0), 0),
    itemRowsTotal: filtered.reduce((sum, part) => sum + Number(part.itemRowsTotal || 0), 0),
    timelineRowsLoaded: filtered.reduce((sum, part) => sum + Number(part.timelineRowsLoaded || 0), 0),
    timelineTruncated: filtered.some((part) => part.timelineTruncated),
    sources: [...new Set(filtered.map((part) => part.source || "queue-service"))],
  };
}

function buildQueueTimeline(timelineItems, queues) {
  const groups = new Map();
  for (const queue of queues || []) {
    groups.set(`${queue.namespace}\0${queue.name}`, {
      namespace: queue.namespace,
      name: queue.name,
      items: [],
    });
  }
  for (const item of timelineItems || []) {
    const key = `${item.namespace}\0${item.queueName}`;
    if (!groups.has(key)) {
      groups.set(key, {
        namespace: item.namespace,
        name: item.queueName,
        items: [],
      });
    }
    groups.get(key).items.push(item);
  }

  const result = [];
  for (const group of groups.values()) {
    const points = group.items.flatMap((item) => [item.created, item.end]).filter(Number.isFinite);
    if (!points.length) continue;
    const start = Math.min(...points);
    const end = Math.max(...points);
    const binCount = Math.max(1, Math.min(QUEUE_TIMELINE_BINS, Math.ceil(Math.sqrt(group.items.length) * 12)));
    const binMs = Math.max(1, (end - start || 1) / binCount);
    const bins = Array.from({ length: binCount }, (_, index) => ({
      start: start + index * binMs,
      end: index === binCount - 1 ? end : start + (index + 1) * binMs,
      total: 0,
      queued: 0,
      leased: 0,
      completed: 0,
      failed: 0,
    }));

    for (const item of group.items) {
      const first = Math.max(0, Math.min(binCount - 1, Math.floor((item.created - start) / binMs)));
      const last = Math.max(0, Math.min(binCount - 1, Math.floor((item.end - start) / binMs)));
      for (let index = first; index <= last; index += 1) {
        const bin = bins[index];
        bin.total += 1;
        bin[item.status] = (bin[item.status] || 0) + 1;
      }
    }

    result.push({
      namespace: group.namespace,
      name: group.name,
      start,
      end,
      itemCount: group.items.length,
      maxBinTotal: Math.max(1, ...bins.map((bin) => bin.total)),
      bins: bins.filter((bin) => bin.total > 0),
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.namespace.localeCompare(b.namespace));
}

function loadQueueDataFromDb(dbPath, sessionId, namespaceHints) {
  const warnings = [];
  if (!fs.existsSync(dbPath)) {
    return {
      dbPath,
      namespaces: [],
      queues: [],
      workers: [],
      timeline: [],
      items: [],
      stats: emptyQueueStats(),
      warnings: [`Queue DB not found at ${dbPath}`],
      itemRowsLoaded: 0,
      itemRowsTotal: 0,
      timelineRowsLoaded: 0,
      timelineTruncated: false,
    };
  }

  let ownedNamespaces = [];
  try {
    ownedNamespaces = sqliteJson(
      dbPath,
      `SELECT * FROM namespaces WHERE owner_thread_id = '${sqlEscape(sessionId)}' ORDER BY updated_at DESC`,
    );
  } catch (err) {
    warnings.push(err.message);
  }

  const namespaceNames = new Set(ownedNamespaces.map((n) => n.namespace));
  for (const hint of namespaceHints || []) namespaceNames.add(hint);
  const names = [...namespaceNames].filter(Boolean);
  if (!names.length) {
    return {
      dbPath,
      namespaces: [],
      queues: [],
      workers: [],
      timeline: [],
      items: [],
      stats: emptyQueueStats(),
      warnings,
      itemRowsLoaded: 0,
      itemRowsTotal: 0,
      timelineRowsLoaded: 0,
      timelineTruncated: false,
    };
  }

  const inList = names.map((n) => `'${sqlEscape(n)}'`).join(",");
  let namespaces = [];
  let queues = [];
  let countRows = [];
  let timelineRows = [];
  let items = [];
  try {
    namespaces = sqliteJson(
      dbPath,
      `SELECT * FROM namespaces WHERE namespace IN (${inList}) ORDER BY updated_at DESC`,
    );
    queues = sqliteJson(
      dbPath,
      `SELECT * FROM queues WHERE namespace IN (${inList}) ORDER BY namespace, name`,
    );
    countRows = sqliteJson(
      dbPath,
      `SELECT namespace, queue_name, status, COUNT(*) AS count
       FROM items
       WHERE namespace IN (${inList})
       GROUP BY namespace, queue_name, status`,
    );
    timelineRows = sqliteJson(
      dbPath,
      `SELECT namespace, queue_name, status, created_at, updated_at, completed_at
       FROM items
       WHERE namespace IN (${inList})
       ORDER BY created_at ASC, queue_name ASC
       LIMIT ${MAX_QUEUE_TIMELINE_ITEMS}`,
    );
    items = uniqueRowsById(
      queueItemDetailQueries(inList).flatMap((query) => sqliteJson(dbPath, query)),
    ).slice(0, MAX_QUEUE_ITEMS);
  } catch (err) {
    warnings.push(err.message);
  }

  const now = Date.now();
  const timelineItems = normalizeQueueTimelineRows(timelineRows, now);
  const stats = queueStatsFromCounts(countRows, timelineItems);
  const normalizedItems = items.map((item) => {
    let payload = {};
    let result = {};
    try {
      payload = item.payload_json ? JSON.parse(item.payload_json) : {};
    } catch {
      payload = {};
    }
    try {
      result = item.result_json ? JSON.parse(item.result_json) : {};
    } catch {
      result = {};
    }
    const created = toMs(item.created_at);
    const updated = toMs(item.updated_at);
    const completed = toMs(item.completed_at);
    const leaseExpires = toMs(item.lease_expires_at);
    const end = completed || (item.status === "leased" ? now : updated || now);
    const workerId = queueWorkerId(item.lease_owner, payload, result);
    return {
      id: item.id,
      namespace: item.namespace,
      queueName: item.queue_name,
      status: item.status,
      label: parsePayloadLabel(payload, item.id.slice(0, 8), item.idempotency_key, item.queue_name),
      idempotencyKey: item.idempotency_key || "",
      leaseOwner: item.lease_owner || "",
      workerId,
      instructions: item.instructions || "",
      payloadPreview: clipText(safeJson(payload), 1200),
      resultPreview: clipText(safeJson(result), 1200),
      attempts: item.attempts,
      maxAttempts: item.max_attempts,
      created,
      updated,
      completed,
      leaseExpires,
      end,
      latencyMs: created && end ? Math.max(0, end - created) : 0,
      activeLeaseMs:
        item.status === "leased" && updated ? Math.max(0, now - updated) : 0,
      findingsTotal: Number(result.findings_total || 0),
      candidateCount: Number(result.candidate_count || 0),
      error: item.error || "",
    };
  });

  const normalizedQueues = queues.map((queue) => {
    const queueItems = normalizedItems.filter(
      (item) => item.namespace === queue.namespace && item.queueName === queue.name,
    );
    const counts = queueCountsFor(countRows, queue.namespace, queue.name);
    return {
      namespace: queue.namespace,
      name: queue.name,
      description: queue.description || "",
      instructions: queue.instructions || "",
      createdAt: queue.created_at,
      updatedAt: queue.updated_at,
      lastActivityAt: queue.last_activity_at,
      lastEnqueuedAt: queue.last_enqueued_at,
      lastClaimedAt: queue.last_claimed_at,
      lastCompletedAt: queue.last_completed_at,
      counts,
      sampleRowsLoaded: queueItems.length,
    };
  });
  const queueTimeline = buildQueueTimeline(timelineItems, normalizedQueues);

  return {
    dbPath,
    namespaces,
    queues: normalizedQueues,
    workers: queueWorkerSessions(normalizedItems, normalizedQueues),
    timeline: queueTimeline,
    items: normalizedItems,
    stats,
    warnings,
    truncated: stats.total > normalizedItems.length,
    itemRowsLoaded: normalizedItems.length,
    itemRowsTotal: stats.total,
    timelineRowsLoaded: timelineItems.length,
    timelineTruncated: stats.total > timelineItems.length,
  };
}

function loadQueueData(sessionId, namespaceHints, appThreads = [], codexHome = CODEX_HOME, options = {}) {
  const queueService = loadQueueDataFromDb(QUEUE_DB, sessionId, namespaceHints);
  const codexSecurityHints = mergeCodexSecurityQueueHints([
    ...codexSecurityQueueHintsFromAppThreads(appThreads),
    ...codexSecurityQueueHintsFromParentThread(sessionId, codexHome),
  ]);
  const codexSecurityQueues = codexSecurityHints.map((hint) =>
    loadCodexSecurityQueueDataFromDb(hint.dbPath, hint.jobIds, { ...options, sessionId }),
  );
  const queue = mergeQueueData([queueService, ...codexSecurityQueues]);
  const diagnostics = discoverRelatedCodexSecurityDiagnostics(sessionId, codexSecurityHints, codexHome);
  queue.unlinkedQueues = diagnostics.queues;
  queue.warnings = [...(queue.warnings || []), ...diagnostics.warnings];
  return queue;
}

function emptyQueue(dbPath, warnings = []) {
  return {
    dbPath,
    namespaces: [],
    queues: [],
    workers: [],
    timeline: [],
    items: [],
    unlinkedQueues: [],
    stats: emptyQueueStats(),
    warnings,
    truncated: false,
    itemRowsLoaded: 0,
    itemRowsTotal: 0,
    timelineRowsLoaded: 0,
    timelineTruncated: false,
  };
}

function syncRemoteQueueDb(remoteName, host) {
  const dir = path.join(REMOTE_CACHE_DIR, safePathPart(remoteName));
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "queues.sqlite");
  try {
    const bytes = sshBuffer(
      host,
      [
        'db="$HOME/.cache/codex-queue-service/queues.sqlite"',
        'test -f "$db" || exit 0',
        'if command -v sqlite3 >/dev/null 2>&1; then',
        '  tmp="$(mktemp /tmp/codex-session-timeline-queues.XXXXXX.sqlite)"',
        '  sqlite3 "$db" ".backup $tmp" >/dev/null',
        '  cat "$tmp"',
        '  status=$?',
        '  rm -f "$tmp"',
        '  exit $status',
        "fi",
        'cat "$db"',
      ].join("\n"),
    );
    if (!bytes.length) {
      return { dbPath, synced: false, warning: `Remote queue DB on ${remoteName} is empty.` };
    }
    fs.writeFileSync(dbPath, bytes);
    return { dbPath, synced: true };
  } catch (err) {
    return {
      dbPath,
      synced: false,
      warning: `Remote queue DB unavailable on ${remoteName}: ${err.message}`,
    };
  }
}

function loadRemoteQueueData(sessionId, namespaceHints, remoteName, host, options = {}) {
  const { dbPath, synced, warning } = syncRemoteQueueDb(remoteName, host);
  if (!synced) return emptyQueue(dbPath, warning ? [warning] : []);
  const queue = loadQueueDataFromDb(dbPath, sessionId, namespaceHints);
  if (warning) queue.warnings.push(warning);
  queue.remote = remoteName;
  return queue;
}

function domainFor(parent, children, queue, appThreads = [], queueWorkers = []) {
  const points = [];
  for (const session of [parent, ...children, ...appThreads, ...queueWorkers]) {
    if (session.start) points.push(session.start);
    if (session.end) points.push(session.end);
    for (const span of session.spans || []) {
      points.push(span.start, span.end);
    }
    for (const marker of session.markers || []) points.push(marker.ts);
  }
  for (const item of queue.items || []) {
    if (item.created) points.push(item.created);
    if (item.end) points.push(item.end);
    if (item.completed) points.push(item.completed);
  }
  for (const track of queue.timeline || []) {
    if (track.start) points.push(track.start);
    if (track.end) points.push(track.end);
  }
  const filtered = points.filter(Number.isFinite);
  if (!filtered.length) return { start: Date.now(), end: Date.now() + 1 };
  const start = Math.min(...filtered);
  const end = Math.max(...filtered);
  return { start, end: end <= start ? start + 1 : end };
}

function namespaceHintsFor(parent, children, appThreads = []) {
  const namespaceHints = new Set(parent.namespaces);
  for (const child of [...children, ...appThreads]) {
    for (const namespace of child.namespaces) namespaceHints.add(namespace);
  }
  return [...namespaceHints];
}

function spawnedLabel(spawned, id) {
  const item = spawned.find((entry) => entry.id === id);
  return item?.nickname ? `${item.nickname} (${id})` : id;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstMarkerDetail(session, type) {
  return (session?.markers || []).find((marker) => marker.type === type)?.detail || "";
}

function promptField(prompt, label) {
  const match = String(prompt || "").match(new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : "";
}

function subagentOtherSource(session) {
  const other = session?.meta?.source?.subagent?.other;
  return typeof other === "string" ? other : "";
}

function agentJobIdForSession(session) {
  const other = subagentOtherSource(session);
  if (other.startsWith("agent_job:")) return other.slice("agent_job:".length);
  return promptField(firstMarkerDetail(session, "user"), "Job ID");
}

function agentJobItemId(session) {
  return promptField(firstMarkerDetail(session, "user"), "Item ID");
}

function hasAgentJobReport(session) {
  return (session?.spans || []).some((span) => span.name === "report_agent_job_result");
}

function csvRecords(text) {
  const records = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value !== "")) records.push(row);
  }
  return records;
}

function readTextFromSource(source, filePath, maxBuffer = 16 * 1024 * 1024) {
  if (!filePath) return { exists: false, text: "", error: "No path provided." };
  try {
    if (source?.type === "remote" && source.host) {
      const exists = sshText(
        source.host,
        `test -f ${shellQuote(filePath)} && printf yes || printf no`,
      ).trim() === "yes";
      if (!exists) return { exists: false, text: "" };
      return {
        exists: true,
        text: sshText(source.host, `cat ${shellQuote(filePath)}`, maxBuffer),
      };
    }

    if (!fs.existsSync(filePath)) return { exists: false, text: "" };
    return { exists: true, text: fs.readFileSync(filePath, "utf8") };
  } catch (err) {
    return { exists: false, text: "", error: err.message || String(err) };
  }
}

function csvInfo(source, filePath, idColumn) {
  const info = {
    path: filePath || "",
    exists: false,
    rowCount: 0,
    values: [],
    idColumn: idColumn || "",
    error: "",
  };
  if (!filePath) return info;

  const read = readTextFromSource(source, filePath);
  info.exists = read.exists;
  if (read.error) info.error = read.error;
  if (!read.exists || read.error) return info;

  try {
    const records = csvRecords(read.text);
    const header = records[0] || [];
    const idIndex = idColumn ? header.indexOf(idColumn) : -1;
    info.rowCount = Math.max(0, records.length - 1);
    if (idIndex >= 0) {
      info.values = records.slice(1).map((row) => row[idIndex] || "").filter(Boolean);
    }
  } catch (err) {
    info.error = err.message || String(err);
  }
  return info;
}

function flattenProcessEntries(value, result = []) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) flattenProcessEntries(item, result);
    return result;
  }
  if (
    Object.keys(value).some((key) =>
      /conversation|process|pid|command|cmd|osPid|pty/i.test(key),
    )
  ) {
    result.push(value);
  }
  for (const item of Object.values(value)) flattenProcessEntries(item, result);
  return result;
}

function loadProcessEntries(source) {
  try {
    const codexHome = source?.codexHome || CODEX_HOME;
    const processManagerFile = path.join(codexHome, "process_manager", "chat_processes.json");
    const text =
      source?.type === "remote" && source.host
        ? sshText(source.host, "cat ~/.codex/process_manager/chat_processes.json 2>/dev/null || true")
        : fs.existsSync(processManagerFile)
          ? fs.readFileSync(processManagerFile, "utf8")
          : "";
    if (!text.trim()) return [];
    return flattenProcessEntries(safeParseJson(text, []));
  } catch {
    return [];
  }
}

function localPidStatus(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return "none";
  try {
    process.kill(value, 0);
    return "live";
  } catch (err) {
    return err?.code === "EPERM" ? "permission denied" : "not running";
  }
}

function shortLine(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function isoTime(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function childLastEventSummary(child) {
  const markers = (child.markers || []).slice().sort((a, b) => clampNumber(a.ts) - clampNumber(b.ts));
  const marker = markers[markers.length - 1];
  if (marker) {
    const detail = marker.detail ? ` (${shortLine(marker.detail, 120)})` : "";
    return `${marker.label || marker.type} at ${isoTime(marker.ts)}${detail}`;
  }
  if (child.end) return `last transcript event at ${isoTime(child.end)}`;
  return "no transcript event beyond session metadata";
}

function agentJobGroups(children, callStart, inputValues) {
  const inputSet = new Set(inputValues || []);
  const groups = new Map();
  for (const child of children || []) {
    const jobId = agentJobIdForSession(child);
    if (!jobId) continue;
    const itemId = agentJobItemId(child);
    const report = hasAgentJobReport(child);
    if (!groups.has(jobId)) {
      groups.set(jobId, {
        jobId,
        children: [],
        itemIds: new Set(),
        reportedItemIds: new Set(),
        reportCount: 0,
        matchCount: 0,
        recentCount: 0,
      });
    }
    const group = groups.get(jobId);
    group.children.push(child);
    if (itemId) group.itemIds.add(itemId);
    if (report) {
      group.reportCount += 1;
      if (itemId) group.reportedItemIds.add(itemId);
    }
    if (itemId && inputSet.has(itemId)) group.matchCount += 1;
    if (Number.isFinite(child.start) && Number.isFinite(callStart) && child.start >= callStart - 60 * 1000) {
      group.recentCount += 1;
    }
  }
  return [...groups.values()];
}

function chooseAgentJobGroup(groups) {
  return groups
    .slice()
    .sort((a, b) => {
      const scoreA = a.matchCount * 4 + a.recentCount * 2 + a.children.length;
      const scoreB = b.matchCount * 4 + b.recentCount * 2 + b.children.length;
      return scoreB - scoreA;
    })[0];
}

function processEntriesForSessionIds(source, sessionIds) {
  const ids = new Set((sessionIds || []).filter(Boolean));
  if (!ids.size) return [];
  return loadProcessEntries(source).filter((entry) => ids.has(entry.conversationId));
}

function processSummaryLines(source, group, parentId, unresolved) {
  if (!group) return [];
  const sessionIds = [parentId, ...group.children.map((child) => child.id)];
  const entries = processEntriesForSessionIds(source, sessionIds);
  const unresolvedIds = new Set(unresolved.map((child) => child.id));
  const unresolvedEntries = entries.filter((entry) => unresolvedIds.has(entry.conversationId));
  const liveEntries = entries
    .map((entry) => ({ entry, pidStatus: localPidStatus(entry.osPid) }))
    .filter(({ pidStatus }) => pidStatus === "live" || pidStatus === "permission denied");

  if (liveEntries.length) {
    return [
      `Process manager: ${entries.length} matching entries; ${liveEntries.length} with a live/visible OS PID.`,
      ...liveEntries.slice(0, MAX_RUNNING_DIAGNOSTIC_ITEMS).map(({ entry, pidStatus }) =>
        `- PID ${entry.osPid} (${pidStatus}): ${shortLine(entry.command || entry.cmd || entry.processId || "unknown command", 220)}`,
      ),
    ];
  }

  const lines = [
    `Process manager: no live OS PID found for this job${entries.length ? ` (${entries.length} matching entries, none with a live osPid)` : ""}.`,
  ];
  if (unresolved.length && !unresolvedEntries.length) {
    lines.push("No process-manager entries matched the unresolved worker sessions.");
  } else if (unresolvedEntries.length) {
    lines.push(`Process-manager entries matched ${unresolvedEntries.length} unresolved worker session(s), but none had a live osPid.`);
  }
  return lines;
}

function spawnAgentsCsvDiagnostics(span, parent, children, source) {
  if (span.name !== "spawn_agents_on_csv") return "";
  const args = span.args || safeParseJson(span.argsPreview || "{}", {});
  const input = csvInfo(source, args.csv_path, args.id_column);
  const output = csvInfo(source, args.output_csv_path, "");
  const groups = agentJobGroups(children, span.start, input.values);
  const group = chooseAgentJobGroup(groups);
  const lines = ["spawn_agents_on_csv diagnostics"];

  if (args.max_runtime_seconds != null) {
    lines.push(`Max worker runtime: ${formatDurationMs(Number(args.max_runtime_seconds) * 1000)}`);
  }
  if (input.path) {
    lines.push(
      `Input CSV: ${input.exists ? `${input.rowCount} row${input.rowCount === 1 ? "" : "s"}` : "missing"} at ${input.path}`,
    );
    if (input.idColumn && input.exists) lines.push(`ID column: ${input.idColumn}`);
    if (input.error) lines.push(`Input CSV error: ${input.error}`);
  }
  if (output.path) {
    lines.push(
      `Output CSV: ${output.exists ? `${output.rowCount} row${output.rowCount === 1 ? "" : "s"} written` : "missing"} at ${output.path}`,
    );
    if (output.error) lines.push(`Output CSV error: ${output.error}`);
  }

  if (!group) {
    lines.push("No matching agent_job child sessions were found yet.");
    return lines.join("\n");
  }

  const unresolved = group.children.filter((child) => !hasAgentJobReport(child));
  const missingInput = input.values.filter((value) => !group.reportedItemIds.has(value));
  lines.push(`Inferred agent_job: ${group.jobId}`);
  lines.push(`Child sessions for job: ${group.children.length}`);
  lines.push(`Worker reports seen: ${group.reportCount}/${group.children.length}`);
  lines.push(`Unresolved worker sessions: ${unresolved.length}`);
  if (missingInput.length) {
    lines.push(`Input IDs without a reported result: ${missingInput.length}`);
    for (const item of missingInput.slice(0, MAX_RUNNING_DIAGNOSTIC_ITEMS)) {
      lines.push(`- ${item}`);
    }
  }
  if (unresolved.length) {
    lines.push("Unresolved child session details:");
    for (const child of unresolved.slice(0, MAX_RUNNING_DIAGNOSTIC_ITEMS)) {
      const itemId = agentJobItemId(child) || "item unknown; no worker prompt captured";
      lines.push(
        `- ${child.id}: ${itemId}; ${childLastEventSummary(child)}; live span ${formatDurationMs(child.elapsedMs || 0)}`,
      );
    }
  }
  lines.push(...processSummaryLines(source, group, parent.id, unresolved));
  return lines.join("\n");
}

function augmentRunningToolDiagnostics(parent, children, source) {
  for (const span of parent.spans || []) {
    if (!(span.active || span.status === "running")) continue;
    const diagnostics = spawnAgentsCsvDiagnostics(span, parent, children, source);
    if (diagnostics) {
      span.detail = clipSpanDetail([span.detail, diagnostics].filter(Boolean).join("\n\n"));
    }
  }
}

function completeSessionPayload({ codexHome, source, parent, children, queue }) {
  const queueForPayload = { ...queue };
  const appThreads = mergedAppThreadSessions([
    ...(parent.appThreads || []),
    ...(queueForPayload.appWorkers || []),
  ]);
  delete queueForPayload.appWorkers;
  const queueWorkers = queueForPayload.workers || [];
  const parentSession = { ...parent };
  delete parentSession.appThreads;
  augmentRunningToolDiagnostics(parent, children, source);
  const domain = domainFor(parent, children, queueForPayload, appThreads, queueWorkers);
  const warnings = [...(queueForPayload.warnings || [])];
  const spawnedIds = new Set(parent.spawned.filter((s) => s.status === "spawned").map((s) => s.id));
  const parsedChildIds = new Set(children.map((c) => c.id));
  for (const id of spawnedIds) {
    if (!parsedChildIds.has(id)) {
      warnings.push(`Spawned child session transcript unavailable: ${spawnedLabel(parent.spawned, id)}`);
    }
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source,
    codexHome,
    session: parentSession,
    subagents: children,
    appThreads,
    queueWorkers,
    queue: queueForPayload,
    domain,
    warnings,
  };
}

function compactDetailText(value, max, kind) {
  const text = String(value || "");
  if (!text || text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n\n... truncated ${omitted} chars. Use "Load all details" to fetch the full ${kind}.`;
}

function compactAppServerSource(source) {
  const compact = { ...source };
  if (compact.prompt) {
    compact.prompt = compactDetailText(compact.prompt, COMPACT_PREVIEW_CHARS, "worker prompt");
  }
  return compact;
}

function compactQueueWorkerSource(source) {
  const compact = { ...source };
  if (Array.isArray(compact.item_samples)) {
    compact.item_samples = compact.item_samples.slice(0, 2).map((item) => ({
      ...item,
      payloadPreview: compactDetailText(item.payloadPreview, COMPACT_PREVIEW_CHARS, "queue item payload"),
      resultPreview: compactDetailText(item.resultPreview, COMPACT_PREVIEW_CHARS, "queue item result"),
    }));
    compact.item_samples_truncated = source.item_samples.length > compact.item_samples.length;
  }
  return compact;
}

function compactSessionMeta(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const compact = { ...meta };
  if (meta.source && typeof meta.source === "object") {
    compact.source = { ...meta.source };
    if (meta.source.app_server) {
      compact.source.app_server = compactAppServerSource(meta.source.app_server);
    }
    if (meta.source.queue_worker) {
      compact.source.queue_worker = compactQueueWorkerSource(meta.source.queue_worker);
    }
  }
  return compact;
}

function compactSpan(span) {
  const compact = {
    id: span.id,
    type: span.type,
    status: span.status,
    name: span.name,
    label: span.label,
    start: span.start,
    end: span.end,
    durationMs: span.durationMs,
    wallMs: span.wallMs,
    exitCode: span.exitCode,
    active: span.active,
  };
  const running = span.active || span.status === "running";
  compact.waitTarget = running ? compactDetailText(span.waitTarget, 240, "wait target") : "";
  compact.argsPreview = "";
  compact.outputPreview = running ? compactDetailText(span.outputPreview, 240, "tool output") : "";
  compact.detail = running
    ? compactDetailText(span.detail, 500, "tool detail")
    : "Compact timeline mode. Use \"Load all details\" to fetch full tool arguments and output.";
  return compact;
}

function compactMarker(marker) {
  return {
    type: marker.type,
    ts: marker.ts,
    label: marker.label,
    payloadType: marker.payloadType,
    detail: compactDetailText(marker.detail, COMPACT_MARKER_DETAIL_CHARS, "event detail"),
  };
}

function compactSession(session) {
  if (!session || typeof session !== "object") return session;
  return {
    ...session,
    meta: compactSessionMeta(session.meta),
    spans: (session.spans || []).map(compactSpan),
    markers: (session.markers || []).map(compactMarker),
  };
}

function compactQueueItem(item) {
  return {
    ...item,
    payloadPreview: compactDetailText(item.payloadPreview, COMPACT_PREVIEW_CHARS, "queue item payload"),
    resultPreview: compactDetailText(item.resultPreview, COMPACT_PREVIEW_CHARS, "queue item result"),
  };
}

function compactQueue(queue) {
  if (!queue || typeof queue !== "object") return queue;
  return {
    ...queue,
    items: (queue.items || []).map(compactQueueItem),
    workers: (queue.workers || []).map(compactSession),
  };
}

function compactSessionPayload(payload) {
  if (!payload?.ok) return payload;
  const queue = compactQueue(payload.queue);
  return {
    ...payload,
    detailMode: "compact",
    detailsComplete: false,
    session: compactSession(payload.session),
    subagents: (payload.subagents || []).map(compactSession),
    appThreads: (payload.appThreads || []).map(compactSession),
    queueWorkers: (payload.queueWorkers || queue?.workers || []).map(compactSession),
    queue,
  };
}

function childParentId(session) {
  return (
    session?.meta?.parentThreadId ||
    session?.meta?.source?.subagent?.thread_spawn?.parent_thread_id ||
    null
  );
}

function isParsedChildSession(parentId, session) {
  if (!session || session.id === parentId) return false;
  return childParentId(session) === parentId;
}

function parsedChildSessions(parentId, sessions) {
  const byId = new Map();
  for (const session of sessions) {
    if (!isParsedChildSession(parentId, session)) continue;
    const existing = byId.get(session.id);
    if (!existing || clampNumber(session.end) > clampNumber(existing.end)) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((a, b) => clampNumber(a.start) - clampNumber(b.start));
}

function appThreadDetailScore(session) {
  const appSource = session?.meta?.source?.app_server || {};
  return (
    clampNumber(session?.metrics?.spanCount) * 4 +
    clampNumber(session?.metrics?.eventCount) +
    clampNumber(appSource.event_rows) +
    (session?.meta?.originator === "app_server_launcher" ? 1000 : 0)
  );
}

function mergedAppThreadSessions(sessions) {
  const byId = new Map();
  for (const session of sessions || []) {
    if (!session?.id) continue;
    const existing = byId.get(session.id);
    if (!existing || appThreadDetailScore(session) > appThreadDetailScore(existing)) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((a, b) => clampNumber(a.start) - clampNumber(b.start));
}

function buildLocalSessionPayload(sessionId, codexHome = CODEX_HOME, options = {}) {
  const index = loadSessionIndex(codexHome);
  const sessionFile = resolveSessionFile(sessionId, codexHome);
  if (!sessionFile) {
    return {
      ok: false,
      error: `No Codex session JSONL found for ${sessionId}`,
      searched: [
        path.join(codexHome, "sessions"),
        path.join(codexHome, "archived_sessions"),
      ],
    };
  }

  const parent = parseSessionFile(sessionFile, index.get(sessionId), options);
  const childRefs = findChildSessionFiles(
    sessionId,
    parent.spawned.filter((s) => s.status === "spawned").map((s) => s.id),
    codexHome,
  );
  const children = parsedChildSessions(
    sessionId,
    childRefs.map((child) => parseSessionFile(child.filePath, index.get(child.id), options)),
  );

  const queue = loadQueueData(
    sessionId,
    namespaceHintsFor(parent, children, parent.appThreads || []),
    parent.appThreads || [],
    codexHome,
    options,
  );
  return completeSessionPayload({
    codexHome,
    source: { type: "local", codexHome },
    parent,
    children,
    queue,
  });
}

function buildRemoteSessionPayload(sessionId, remoteName, host, options = {}) {
  const index = loadRemoteSessionIndex(host);
  const sessionFile = resolveRemoteSessionFile(host, sessionId);
  if (!sessionFile) {
    return {
      ok: false,
      error: `No Codex session JSONL found for ${sessionId} on remote ${remoteName}`,
      searched: [
        `${host}:~/.codex/sessions`,
        `${host}:~/.codex/archived_sessions`,
      ],
    };
  }

  const parent = parseSessionRows(readRemoteJsonl(host, sessionFile), `${remoteName}:${sessionFile}`, index.get(sessionId), options);
  const childRefs = findRemoteChildSessionFiles(
    host,
    sessionId,
    parent.spawned.filter((s) => s.status === "spawned").map((s) => s.id),
  );
  const children = parsedChildSessions(
    sessionId,
    childRefs.map((child) =>
      parseSessionRows(readRemoteJsonl(host, child.filePath), `${remoteName}:${child.filePath}`, index.get(child.id), options),
    ),
  );

  const queue = loadRemoteQueueData(sessionId, namespaceHintsFor(parent, children, parent.appThreads || []), remoteName, host, options);
  return completeSessionPayload({
    codexHome: `${host}:~/.codex`,
    source: { type: "remote", remote: remoteName, host },
    parent,
    children,
    queue,
  });
}

function buildSessionPayload(sessionId, options = {}) {
  const remoteName = options.remote || "";
  if (remoteName) return buildRemoteSessionPayload(sessionId, remoteName, resolveRemoteHost(remoteName), options);
  return buildLocalSessionPayload(sessionId, resolveCodexHome(options.codexHome), options);
}

function buildLocalSessionQueuePayload(sessionId, codexHome = CODEX_HOME, options = {}) {
  const index = loadSessionIndex(codexHome);
  const queue = loadQueueData(sessionId, [], [], codexHome, options);
  const indexEntry = index.get(sessionId) || {};
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: { type: "local", codexHome },
    session: {
      id: sessionId,
      title: indexEntry.thread_name || indexEntry.title || "",
    },
    queue,
    queueWorkers: queue.workers || [],
    warnings: queue.warnings || [],
  };
}

function buildSessionQueuePayload(sessionId, options = {}) {
  const remoteName = options.remote || "";
  if (!remoteName) {
    return buildLocalSessionQueuePayload(sessionId, resolveCodexHome(options.codexHome), options);
  }
  const payload = buildSessionPayload(sessionId, options);
  if (!payload.ok) return payload;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: payload.source,
    session: {
      id: payload.session?.id || sessionId,
      title: payload.session?.title || "",
    },
    queue: payload.queue,
    queueWorkers: payload.queueWorkers || payload.queue?.workers || [],
    warnings: payload.warnings || [],
  };
}

function requestOptionsFromSearch(searchParams) {
  const launcherEvents = String(
    searchParams.get("events") || searchParams.get("launcher_events") || "",
  ).toLowerCase();
  return {
    remote: searchParams.get("remote") || "",
    codexHome: searchParams.get("codex_home") || searchParams.get("codexHome") || "",
    launcherEventsMode: ["all", "full"].includes(launcherEvents) ? "all" : "latest",
  };
}

function withLauncherEventMode(payload, options) {
  if (!payload?.ok) return payload;
  return {
    ...payload,
    launcherEventsMode: options.launcherEventsMode || "latest",
    launcherEventLimit: MAX_LAUNCHER_EVENT_ROWS,
  };
}

function listRecentSessions(limit, q, options = {}) {
  const remoteName = options.remote || "";
  const codexHome = resolveCodexHome(options.codexHome);
  const index = remoteName
    ? loadRemoteSessionIndex(resolveRemoteHost(remoteName))
    : loadSessionIndex(codexHome);
  const entries = [...index.values()]
    .filter((row) => {
      if (!q) return true;
      const needle = q.toLowerCase();
      return (
        String(row.id || "").toLowerCase().includes(needle) ||
        String(row.thread_name || "").toLowerCase().includes(needle) ||
        String(row.title || "").toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, limit);
  return entries;
}

function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const requested = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!requested.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(requested) || !fs.statSync(requested).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(requested);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(requested).pipe(res);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = parsed.pathname;

  if (pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      codexHome: CODEX_HOME,
      queueDb: QUEUE_DB,
      queueDbExists: fs.existsSync(QUEUE_DB),
      remoteHosts: Object.keys(REMOTE_HOSTS).sort(),
    });
    return;
  }

  if (pathname === "/api/sessions") {
    const limit = Math.max(1, Math.min(200, Number(parsed.searchParams.get("limit") || 50)));
    const q = parsed.searchParams.get("q") || "";
    const remote = parsed.searchParams.get("remote") || "";
    const codexHome = parsed.searchParams.get("codex_home") || parsed.searchParams.get("codexHome") || "";
    try {
      sendJson(res, 200, {
        ok: true,
        source: remote ? { type: "remote", remote } : { type: "local", codexHome: resolveCodexHome(codexHome) },
        sessions: listRecentSessions(limit, q, { remote, codexHome }),
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message || "Unable to list sessions." });
    }
    return;
  }

  const queueMatch = pathname.match(/^\/api\/session\/([^/]+)\/queue$/);
  if (queueMatch) {
    const sessionId = decodeURIComponent(queueMatch[1]);
    if (!isSafeSessionId(sessionId)) {
      sendJson(res, 400, { ok: false, error: "Unsafe or invalid session id." });
      return;
    }
    try {
      const options = requestOptionsFromSearch(parsed.searchParams);
      const payload = withLauncherEventMode(buildSessionQueuePayload(sessionId, options), options);
      sendJson(res, payload.ok ? 200 : 404, payload);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message, stack: process.env.DEBUG ? err.stack : undefined });
    }
    return;
  }

  const match = pathname.match(/^\/api\/session\/([^/]+)$/);
  if (match) {
    const sessionId = decodeURIComponent(match[1]);
    if (!isSafeSessionId(sessionId)) {
      sendJson(res, 400, { ok: false, error: "Unsafe or invalid session id." });
      return;
    }
    try {
      const full = ["1", "true", "yes"].includes(String(parsed.searchParams.get("full") || "").toLowerCase());
      const options = requestOptionsFromSearch(parsed.searchParams);
      const payload = withLauncherEventMode(buildSessionPayload(sessionId, options), options);
      const responsePayload = full ? { ...payload, detailMode: "full", detailsComplete: true } : compactSessionPayload(payload);
      sendJson(res, responsePayload.ok ? 200 : 404, responsePayload);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message, stack: process.env.DEBUG ? err.stack : undefined });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Codex session timeline running at http://127.0.0.1:${PORT}/`);
  console.log(`CODEX_HOME=${CODEX_HOME}`);
  console.log(`QUEUE_SERVICE_DB=${QUEUE_DB}`);
});
