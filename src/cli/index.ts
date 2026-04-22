#!/usr/bin/env node
// Silence Node's "SQLite is an experimental feature" warning — we rely on
// node:sqlite intentionally and don't want the noise in the CLI output.
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /SQLite/.test(w.message)) return;
  // eslint-disable-next-line no-console
  console.warn(w);
});

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { ClawBus } from "../core/bus.js";
import { SQLiteAdapter } from "../adapters/sqlite.js";
import { runPlanner } from "../agents/planner.js";
import { runWorker } from "../agents/worker.js";
import { startApprovalGate } from "../agents/approval.js";
import type { ClawBusMessage } from "../core/types.js";

interface Args {
  command: string;
  flags: Map<string, string | true>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const [, , command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        flags.set(tok.slice(2, eq), tok.slice(eq + 1));
      } else {
        const next = rest[i + 1];
        if (next && !next.startsWith("--")) {
          flags.set(tok.slice(2), next);
          i += 1;
        } else {
          flags.set(tok.slice(2), true);
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { command, flags, positional };
}

const HELP = `
clawbus — minimal protocol for Claude Code agent teams

usage:
  clawbus init                                       create .clawbus/ in cwd
  clawbus run --goal "..." [--cwd PATH] [--auto]     plan + execute once
  clawbus demo [--auto]                              run the canned demo
  clawbus logs [--kind KIND] [--limit N]             print the message timeline
  clawbus help                                       show this help

env:
  ANTHROPIC_API_KEY   required for planner/worker (SDK calls)
  CLAWBUS_DB_PATH     override the SQLite path (default: .clawbus/bus.sqlite)
`.trim();

function defaultDbPath(): string {
  return (
    process.env["CLAWBUS_DB_PATH"] ??
    path.join(process.cwd(), ".clawbus", "bus.sqlite")
  );
}

async function cmdInit(): Promise<void> {
  const dir = path.join(process.cwd(), ".clawbus");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "bus.sqlite");
  const adapter = new SQLiteAdapter({ path: dbPath });
  await adapter.close();
  console.log(`initialized ${dir} (sqlite at ${dbPath})`);
}

async function cmdRun(args: Args): Promise<void> {
  const goal = args.flags.get("goal");
  if (typeof goal !== "string") {
    console.error("clawbus run: --goal '...' is required");
    process.exit(2);
  }
  const cwd =
    typeof args.flags.get("cwd") === "string"
      ? path.resolve(String(args.flags.get("cwd")))
      : process.cwd();
  const autoApprove = args.flags.get("auto") === true;
  const model =
    typeof args.flags.get("model") === "string"
      ? String(args.flags.get("model"))
      : undefined;

  await runPipeline({
    goal,
    cwd,
    autoApprove,
    ...(model !== undefined ? { model } : {}),
  });
}

async function cmdDemo(args: Args): Promise<void> {
  const autoApprove = args.flags.get("auto") === true;
  const thisFile = url.fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(thisFile), "..", "..");
  const exampleDir = path.join(pkgRoot, "examples", "broken-node-project");
  if (!fs.existsSync(exampleDir)) {
    console.error(`demo example not found at ${exampleDir}`);
    process.exit(2);
  }
  console.log(`[demo] target: ${exampleDir}`);
  await runPipeline({
    goal: "Run `npm test` in the working directory. Identify the single failing test, find the bug in src/fizzbuzz.mjs, apply a one-line fix using the Edit tool, then re-run `npm test` to confirm everything passes.",
    cwd: exampleDir,
    autoApprove,
  });
}

async function runPipeline(opts: {
  goal: string;
  cwd: string;
  autoApprove: boolean;
  model?: string;
}): Promise<void> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      "ANTHROPIC_API_KEY is not set — planner/worker cannot call the SDK.",
    );
    process.exit(2);
  }

  const dbPath = defaultDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const bus = new ClawBus({ adapter: new SQLiteAdapter({ path: dbPath }) });

  const gate = startApprovalGate(bus, { autoApprove: opts.autoApprove });

  try {
    console.log(`[planner] goal: ${opts.goal}`);
    const planResult = await runPlanner(bus, {
      goal: opts.goal,
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
    });
    console.log(
      `[planner] produced ${planResult.plan.length} subtask(s) (cost $${planResult.costUsd.toFixed(
        4,
      )}):`,
    );
    for (const s of planResult.plan) {
      console.log(`  - [${s.id}] ${s.goal}`);
    }

    for (const taskMsg of planResult.taskMessages) {
      const goal = (taskMsg.payload as { goal: string }).goal;
      console.log(`\n[worker] executing: ${goal}`);
      const workerResult = await runWorker(bus, {
        taskMessage: taskMsg,
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
      });
      console.log(
        `[worker] done (approvals=${workerResult.approvals} rejections=${workerResult.rejections} cost=$${workerResult.costUsd.toFixed(4)})`,
      );
      console.log(`[worker] summary:\n${indent(workerResult.text, 2)}`);
    }
  } finally {
    await gate.stop();
    await bus.close();
  }

  console.log(
    `\n[ok] pipeline complete. run 'clawbus logs' to inspect the full message timeline.`,
  );
}

async function cmdLogs(args: Args): Promise<void> {
  const kind = args.flags.get("kind");
  const limitRaw = args.flags.get("limit");
  const limit = typeof limitRaw === "string" ? Number(limitRaw) : undefined;
  const dbPath = defaultDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`no bus found at ${dbPath} — run 'clawbus init' first.`);
    process.exit(2);
  }
  const bus = new ClawBus({ adapter: new SQLiteAdapter({ path: dbPath }) });
  try {
    const filter =
      typeof kind === "string"
        ? ({ kind: kind as ClawBusMessage["kind"] } as const)
        : {};
    const messages = await bus.query(filter);
    const slice =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? messages.slice(-limit)
        : messages;
    for (const m of slice) {
      printLogLine(m);
    }
    console.log(`\n(${slice.length} of ${messages.length} messages shown)`);
  } finally {
    await bus.close();
  }
}

function printLogLine(m: ClawBusMessage): void {
  const ts = m.createdAt.replace("T", " ").replace("Z", "");
  const parentBit = m.parent ? ` ← ${m.parent.slice(-6)}` : "";
  const head = `${ts}  ${m.id.slice(-6)}${parentBit}  ${m.from} → ${m.to}  [${m.kind}]`;
  console.log(head);
  const preview = previewPayload(m);
  if (preview) console.log(indent(preview, 4));
}

function previewPayload(m: ClawBusMessage): string {
  const p = m.payload as Record<string, unknown>;
  if (!p || typeof p !== "object") return String(p);
  if (m.kind === "task" && typeof p["goal"] === "string") return `goal: ${p["goal"]}`;
  if (m.kind === "result" && typeof p["summary"] === "string")
    return `status: ${p["status"]}\n${p["summary"]}`;
  if (m.kind === "approval-request" && typeof p["action"] === "string")
    return `action: ${p["action"]}\nseverity: ${p["severity"]}\n${p["rationale"]}`;
  if (m.kind === "approval-decision" && typeof p["decision"] === "string")
    return `decision: ${p["decision"]}${p["note"] ? ` (${p["note"]})` : ""}`;
  if (m.kind === "log" && typeof p["text"] === "string")
    return `[${p["level"]}] ${p["text"]}`;
  try {
    return JSON.stringify(p, null, 2);
  } catch {
    return String(p);
  }
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "init":
      await cmdInit();
      break;
    case "run":
      await cmdRun(args);
      break;
    case "demo":
      await cmdDemo(args);
      break;
    case "logs":
      await cmdLogs(args);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${args.command}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
