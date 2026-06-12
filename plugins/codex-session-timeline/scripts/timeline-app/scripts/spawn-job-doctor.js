#!/usr/bin/env node
"use strict";

const cp = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function usage() {
  console.log(`Usage:
  node scripts/spawn-job-doctor.js --job-id <uuid> [options]
  node scripts/spawn-job-doctor.js --output-csv <abs-path> [options]
  node scripts/spawn-job-doctor.js --input-csv <abs-path> [options]

Options:
  --state-db <path>          Codex SQLite state DB
  --statuses <list>          Comma list to retry, default: every non-completed item
  --id-column <name>         Override inferred CSV id column
  --retry-csv <path>         Write retry input CSV for selected items
  --retry-output-csv <path>  Retry output CSV path for generated spawn JSON
  --spawn-json <path>        Write spawn_agents_on_csv JSON args for retry
  --max-concurrency <n>      Retry concurrency in generated spawn JSON, default min(4, rows)
  --grace-seconds <n>        Extra age before running items are called stale, default 60
  --json                     Print machine-readable audit JSON

Examples:
  node scripts/spawn-job-doctor.js \\
    --job-id 0b8a77b3-3c37-4603-bbe8-152bd4774f62 \\
    --retry-csv /private/tmp/retry.csv \\
    --spawn-json /private/tmp/retry.spawn_agents_on_csv.json
`);
}

function parseArgs(argv) {
  const args = {
    graceSeconds: 60,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      args[key] = value;
      i += 1;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (args.graceSeconds !== undefined) args.graceSeconds = Number(args.graceSeconds);
  if (args.maxConcurrency !== undefined) args.maxConcurrency = Number(args.maxConcurrency);
  if (!Number.isFinite(args.graceSeconds)) throw new Error("--grace-seconds must be a number");
  if (args.maxConcurrency !== undefined && !Number.isFinite(args.maxConcurrency)) {
    throw new Error("--max-concurrency must be a number");
  }
  return args;
}

function defaultStateDb() {
  const candidates = [
    path.join(os.homedir(), ".codex", "sqlite", "state_5.sqlite"),
    path.join(os.homedir(), ".codex", "state_5.sqlite"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`No Codex state DB found in ${candidates.join(" or ")}`);
  return found;
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqliteJson(dbPath, sql) {
  const output = cp.execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function requireOne(rows, description) {
  if (rows.length === 0) throw new Error(`No ${description} found`);
  if (rows.length > 1) {
    const ids = rows.map((row) => row.id).join(", ");
    throw new Error(`Expected one ${description}, found ${rows.length}: ${ids}`);
  }
  return rows[0];
}

function findJob(dbPath, args) {
  const baseSelect = `
    SELECT id, name, status, instruction, output_schema_json, input_headers_json,
           input_csv_path, output_csv_path, auto_export, created_at, updated_at,
           started_at, completed_at, last_error, max_runtime_seconds
      FROM agent_jobs
  `;
  if (args.jobId) {
    return requireOne(
      sqliteJson(dbPath, `${baseSelect} WHERE id = ${sqlQuote(args.jobId)};`),
      "job",
    );
  }
  if (args.outputCsv) {
    return requireOne(
      sqliteJson(
        dbPath,
        `${baseSelect} WHERE output_csv_path = ${sqlQuote(args.outputCsv)} ORDER BY created_at DESC LIMIT 2;`,
      ),
      "job",
    );
  }
  if (args.inputCsv) {
    return requireOne(
      sqliteJson(
        dbPath,
        `${baseSelect} WHERE input_csv_path = ${sqlQuote(args.inputCsv)} ORDER BY created_at DESC LIMIT 2;`,
      ),
      "job",
    );
  }
  const recent = sqliteJson(
    dbPath,
    `${baseSelect} ORDER BY created_at DESC LIMIT 8;`,
  );
  throw new Error(
    `Specify --job-id, --output-csv, or --input-csv. Recent jobs:\n${recent
      .map((job) => `  ${job.id} ${job.status} ${job.output_csv_path}`)
      .join("\n")}`,
  );
}

function loadItems(dbPath, jobId) {
  return sqliteJson(
    dbPath,
    `SELECT row_index, item_id, source_id, row_json, status, assigned_thread_id,
            attempt_count, result_json, last_error, created_at, updated_at,
            completed_at, reported_at
       FROM agent_job_items
      WHERE job_id = ${sqlQuote(jobId)}
      ORDER BY row_index;`,
  );
}

function loadThreads(dbPath, threadIds) {
  const ids = [...new Set(threadIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = sqliteJson(
    dbPath,
    `SELECT id, title, rollout_path, created_at, updated_at, preview
       FROM threads
      WHERE id IN (${ids.map(sqlQuote).join(",")});`,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

function countByStatus(items) {
  const counts = {};
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}

function parseJsonMaybe(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function inferHeaders(job, items) {
  const fromJob = parseJsonMaybe(job.input_headers_json, null);
  if (Array.isArray(fromJob) && fromJob.length > 0) return fromJob;
  for (const item of items) {
    const row = parseJsonMaybe(item.row_json, null);
    if (row && typeof row === "object") return Object.keys(row);
  }
  return [];
}

function inferIdColumn(headers, items) {
  let best = { header: null, matches: -1 };
  for (const header of headers) {
    let matches = 0;
    for (const item of items) {
      const row = parseJsonMaybe(item.row_json, {});
      if (String(row[header] ?? "") === String(item.item_id)) matches += 1;
    }
    if (matches > best.matches) best = { header, matches };
  }
  return best.header;
}

function selectedItems(args, items) {
  if (!args.statuses) return items.filter((item) => item.status !== "completed");
  const wanted = new Set(String(args.statuses).split(",").map((part) => part.trim()).filter(Boolean));
  return items.filter((item) => wanted.has(item.status));
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function writeCsv(filePath, headers, rows) {
  const body = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body}\n`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function inspectThread(thread) {
  if (!thread?.rollout_path) return { found: false };
  const info = {
    found: true,
    rollout_path: thread.rollout_path,
    line_count: 0,
    has_prompt: false,
    has_report: false,
    has_abort: false,
    last_event: null,
  };
  if (!fs.existsSync(thread.rollout_path)) {
    info.missing_rollout = true;
    return info;
  }
  const lines = fs.readFileSync(thread.rollout_path, "utf8").split(/\r?\n/).filter(Boolean);
  info.line_count = lines.length;
  for (const line of lines) {
    const event = parseJsonMaybe(line, null);
    if (!event) continue;
    info.last_event = event.type;
    if (event.type === "response_item" && event.payload?.type === "message") {
      const role = event.payload.role;
      const text = JSON.stringify(event.payload.content || "");
      if (role === "user" && !text.includes("<turn_aborted>")) info.has_prompt = true;
      if (text.includes("report_agent_job_result")) info.has_report = true;
    }
    if (event.type === "event_msg" && event.payload?.type === "turn_aborted") {
      info.has_abort = true;
    }
  }
  return info;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "unknown";
  const sign = seconds < 0 ? "-" : "";
  let remaining = Math.abs(Math.floor(seconds));
  const h = Math.floor(remaining / 3600);
  remaining -= h * 3600;
  const m = Math.floor(remaining / 60);
  const s = remaining - m * 60;
  if (h) return `${sign}${h}h ${m}m ${s}s`;
  if (m) return `${sign}${m}m ${s}s`;
  return `${sign}${s}s`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const dbPath = args.stateDb || defaultStateDb();
  const job = findJob(dbPath, args);
  const items = loadItems(dbPath, job.id);
  const headers = inferHeaders(job, items);
  const idColumn = args.idColumn || inferIdColumn(headers, items);
  const chosen = selectedItems(args, items);
  const threads = loadThreads(dbPath, chosen.map((item) => item.assigned_thread_id));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxRuntime = Number(job.max_runtime_seconds || 0);

  const chosenWithDetails = chosen.map((item) => {
    const thread = threads.get(item.assigned_thread_id);
    const ageSeconds = item.updated_at ? nowSeconds - Number(item.updated_at) : null;
    const staleAfter = maxRuntime ? maxRuntime + args.graceSeconds : null;
    return {
      row_index: item.row_index,
      item_id: item.item_id,
      status: item.status,
      assigned_thread_id: item.assigned_thread_id || "",
      attempt_count: item.attempt_count,
      last_error: item.last_error || "",
      updated_at: item.updated_at,
      age_seconds: ageSeconds,
      stale: item.status === "running" && staleAfter !== null && ageSeconds > staleAfter,
      thread: inspectThread(thread),
      row: parseJsonMaybe(item.row_json, {}),
    };
  });

  let retryCsv = null;
  let spawnJson = null;
  if (args.retryCsv) {
    if (!idColumn) throw new Error("Could not infer id column; pass --id-column");
    writeCsv(args.retryCsv, headers, chosenWithDetails.map((item) => item.row));
    retryCsv = path.resolve(args.retryCsv);
  }

  if (args.spawnJson) {
    if (!retryCsv) throw new Error("--spawn-json requires --retry-csv");
    const retryOutputCsv = args.retryOutputCsv
      ? path.resolve(args.retryOutputCsv)
      : retryCsv.replace(/\.csv$/i, "") + "_results.csv";
    const outputSchema = parseJsonMaybe(job.output_schema_json, undefined);
    const retryConcurrency = Math.max(
      1,
      Math.min(args.maxConcurrency || 4, Math.max(1, chosenWithDetails.length)),
    );
    spawnJson = {
      csv_path: retryCsv,
      id_column: idColumn,
      instruction: job.instruction,
      max_concurrency: retryConcurrency,
      max_runtime_seconds: maxRuntime || undefined,
      output_csv_path: retryOutputCsv,
      output_schema: outputSchema,
    };
    writeJson(args.spawnJson, spawnJson);
  }

  const audit = {
    state_db: dbPath,
    job: {
      id: job.id,
      name: job.name,
      status: job.status,
      input_csv_path: job.input_csv_path,
      output_csv_path: job.output_csv_path,
      max_runtime_seconds: job.max_runtime_seconds,
      started_at: job.started_at,
      updated_at: job.updated_at,
      completed_at: job.completed_at,
      last_error: job.last_error || "",
    },
    id_column: idColumn,
    counts: countByStatus(items),
    selected_count: chosenWithDetails.length,
    selected: chosenWithDetails.map(({ row, ...rest }) => rest),
    retry_csv: retryCsv,
    spawn_json_path: args.spawnJson ? path.resolve(args.spawnJson) : null,
    spawn_json: args.json ? spawnJson : undefined,
  };

  if (args.json) {
    console.log(JSON.stringify(audit, null, 2));
    return;
  }

  console.log(`State DB: ${audit.state_db}`);
  console.log(`Job: ${job.id} (${job.status})`);
  console.log(`Input CSV: ${job.input_csv_path}`);
  console.log(`Output CSV: ${job.output_csv_path}${fs.existsSync(job.output_csv_path) ? "" : " (missing)"}`);
  console.log(`ID column: ${idColumn || "unknown"}`);
  console.log(`Counts: ${Object.entries(audit.counts).map(([status, count]) => `${status}=${count}`).join(", ")}`);
  console.log(`Selected for retry/audit: ${chosenWithDetails.length}`);

  for (const item of chosenWithDetails) {
    const age = item.age_seconds === null ? "unknown age" : formatDuration(item.age_seconds);
    const stale = item.stale ? " STALE" : "";
    console.log(`- row ${item.row_index}: ${item.item_id} [${item.status}] ${age}${stale}`);
    if (item.assigned_thread_id) console.log(`  thread: ${item.assigned_thread_id}`);
    if (item.last_error) console.log(`  error: ${item.last_error}`);
    if (item.thread?.found) {
      console.log(
        `  transcript: ${item.thread.rollout_path} (${item.thread.line_count} rows, prompt=${item.thread.has_prompt}, report=${item.thread.has_report}, abort=${item.thread.has_abort})`,
      );
    }
  }

  if (retryCsv) console.log(`Retry CSV written: ${retryCsv}`);
  if (args.spawnJson) console.log(`spawn_agents_on_csv args written: ${path.resolve(args.spawnJson)}`);
}

try {
  main();
} catch (error) {
  console.error(`spawn-job-doctor: ${error.message}`);
  process.exit(1);
}
