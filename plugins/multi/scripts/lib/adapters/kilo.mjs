/**
 * Kilo adapter — availability checks, auth status, and running prompts
 * through Kilo CLI's ACP server (`kilo acp`).
 *
 * Kilo is the `kilo` command (or `kilo.cmd` on Windows), installed globally
 * via `npm install -g kilo`. It exposes ACP as a first-class subcommand
 * (`kilo acp`), unlike CLIs that gate it behind a `--acp` flag.
 *
 * Kilo currently runs as a single agent (no role-specific slash modes such
 * as /plan or /debug). Role prefixing is therefore a no-op today; the map
 * is preserved so future Kilo modes can be wired in one place.
 *
 * Models use a `provider/model` format (e.g. `anthropic/claude-sonnet-4.6`).
 * `session/set_model` is forwarded with whatever the user supplies via
 * --model and is the same string Kilo's `-m` flag accepts.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildAutoApproveRequestHandler, SpawnedAcpClient } from "../acp-client.mjs";
import { sanitizeDiagnosticMessage } from "../acp-diagnostics.mjs";
import { buildStandardMcpServers } from "../mcp-servers.mjs";

// ─── Binary resolution ────────────────────────────────────────────────────────
//
// Kilo is installed globally via npm and lives in the npm global bin
// directory. On Windows this is %APPDATA%\npm\kilo.cmd; on Unix it's
// `kilo` on PATH.

const KILO_WINDOWS_FALLBACK =
  (process.env.APPDATA ?? "C:/Users/" + (process.env.USERNAME ?? process.env.USER ?? "User") + "/AppData/Roaming") +
  "/npm/kilo.cmd";

function findKiloBinary() {
  // User override always wins.
  if (process.env.KILO_CLI_PATH) {
    return process.env.KILO_CLI_PATH.replace(/\\/g, "/");
  }

  const whereCmd = process.platform === "win32" ? "where kilo" : "which kilo";
  try {
    const found = execSync(whereCmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      .split(/\r?\n/)
      .filter(Boolean)[0];
    if (found) {
      return found.replace(/\\/g, "/");
    }
  } catch {
    // Not on PATH — fall through to platform-specific fallback.
  }

  if (process.platform === "win32") {
    return KILO_WINDOWS_FALLBACK;
  }

  return "kilo";
}

// ─── Role-to-prompt-prefix mapping ───────────────────────────────────────────

function buildPrompt(role, userTask) {
  const prefix = {
    // No role-specific prefixes today.
  }[role] ?? "";
  return prefix + userTask;
}

// ─── Stream event helpers ─────────────────────────────────────────────────────

function emitStreamEvent(onStream, event) {
  if (!onStream) return;
  try {
    onStream(event);
  } catch {
    // Best-effort.
  }
}

// ─── Notification dispatch ────────────────────────────────────────────────────

function createNotificationSinks() {
  return {
    textChunks: [],
    chunkCount: 0,
    chunkChars: 0,
    toolCalls: [],
    fileChanges: [],
    events: []
  };
}

function dispatchOneNotification(notification, sinks, onStream) {
  const update = notification?.params?.update;
  if (!update) return;

  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    const text = String(update.content.text ?? "");
    sinks.textChunks.push(text);
    sinks.chunkCount += 1;
    sinks.chunkChars += text.length;
    const ev = { type: "message_chunk", text };
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  } else if (update.sessionUpdate === "tool_call") {
    sinks.toolCalls.push({
      name: update.toolName ?? update.name ?? "unknown",
      arguments: update.arguments ?? update.input ?? {},
      result: update.result ?? undefined
    });
    const ev = {
      type: "tool_call",
      toolName: sanitizeDiagnosticMessage(update.toolName ?? update.name ?? "unknown") || "unknown"
    };
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  } else if (update.sessionUpdate === "file_change") {
    sinks.fileChanges.push({
      path: update.path ?? "",
      action: update.action ?? "modify"
    });
    const ev = {
      type: "file_change",
      path: sanitizeDiagnosticMessage(update.path ?? ""),
      action: sanitizeDiagnosticMessage(update.action ?? "modify") || "modify"
    };
    sinks.events?.push(ev);
    emitStreamEvent(onStream, ev);
  }
}

// ─── Availability & Auth ──────────────────────────────────────────────────────

export function getKiloAvailability() {
  const cli = findKiloBinary();
  try {
    const version = execSync(`"${cli}" --version`, {
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 8000
    }).trim();
    return { available: true, detail: `kilo ${version}`, version };
  } catch (err) {
    return {
      available: false,
      detail: `Kilo CLI not found (tried: ${cli}). Install with: npm install -g kilo. Error: ${String(err.message ?? err)}`,
      version: null
    };
  }
}

/**
 * Check Kilo authentication status.
 *
 * Kilo supports two auth backends:
 *   1. Provider env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) — direct.
 *   2. Kilo Gateway OAuth, stored in `~/.local/share/kilo/auth.json` on Unix
 *      or `%LOCALAPPDATA%/kilo/auth.json` on Windows.
 *
 * Either path is sufficient. If neither matches, we still report "available"
 * when the binary works and let the ACP layer surface the real auth error.
 */
export function getKiloAuthStatus() {
  const tokenEnvVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"];
  for (const envVar of tokenEnvVars) {
    if (process.env[envVar]) {
      return {
        authenticated: true,
        loggedIn: true,
        method: envVar,
        detail: `Authenticated via ${envVar} environment variable.`
      };
    }
  }

  const authPath = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? "", "kilo", "auth.json")
    : path.join(process.env.HOME ?? "", ".local", "share", "kilo", "auth.json");
  if (authPath && fs.existsSync(authPath)) {
    return {
      authenticated: true,
      loggedIn: true,
      method: "kilo-gateway",
      detail: `Authenticated via Kilo Gateway credentials at ${authPath}.`
    };
  }

  const avail = getKiloAvailability();
  if (avail.available) {
    return {
      authenticated: true,
      loggedIn: true,
      method: "kilo-cli",
      detail: `Kilo CLI available (${avail.version}). Auth will be confirmed on first use.`
    };
  }

  return {
    authenticated: false,
    loggedIn: false,
    method: null,
    detail: "Kilo CLI not found. Install with `npm install -g kilo`, then `kilo auth login` (Kilo Gateway OAuth) or set ANTHROPIC_API_KEY for direct provider access."
  };
}

// ─── ACP Operations ───────────────────────────────────────────────────────────

export async function runAcpPromptKilo(cwd, prompt, options = {}) {
  const sinks = createNotificationSinks();
  const role = options.role ?? "writer";
  const fullPrompt = buildPrompt(role, prompt);

  const notificationHandler = (notification) => {
    dispatchOneNotification(notification, sinks, options.onStream);
    if (options.onNotification) {
      options.onNotification(notification);
    }
  };

  const diagnosticHandler = (payload) => {
    if (options.onDiagnostic) {
      try {
        options.onDiagnostic(payload);
      } catch {
        // Best-effort.
      }
    }
  };

  const cli = findKiloBinary();
  const client = new SpawnedAcpClient(cwd, {
    command: cli,
    args: ["acp"],
    env: options.env ?? process.env,
    onNotification: notificationHandler,
    onDiagnostic: diagnosticHandler,
    onRequest: buildAutoApproveRequestHandler()
  });

  const mcpServers = buildStandardMcpServers();

  try {
    await client.initialize();

    let sessionId = options.sessionId ?? null;
    if (sessionId) {
      await client.request("session/load", { sessionId, cwd, mcpServers });
    } else {
      const session = await client.request("session/new", { cwd, mcpServers });
      sessionId = session?.sessionId ?? null;
    }

    if (options.model) {
      try {
        await client.request("session/set_model", { sessionId, modelId: options.model });
      } catch (error) {
        process.stderr.write(`Warning: could not set model to ${options.model}: ${error?.message ?? error}\n`);
      }
    }

    await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: fullPrompt }]
    });

    const text = sinks.textChunks.join("");

    return {
      sessionId,
      text,
      chunkCount: sinks.chunkCount,
      chunkChars: sinks.chunkChars,
      toolCalls: sinks.toolCalls,
      fileChanges: sinks.fileChanges,
      error: null
    };
  } catch (error) {
    return {
      sessionId: null,
      text: sinks.textChunks.join(""),
      chunkCount: sinks.chunkCount,
      chunkChars: sinks.chunkChars,
      toolCalls: sinks.toolCalls,
      fileChanges: sinks.fileChanges,
      error
    };
  } finally {
    await client.close();
  }
}

export async function interruptAcpPromptKilo(jobId) {
  return {
    attempted: false,
    interrupted: false,
    transport: null,
    detail: `Cancel not implemented for Kilo ACP (jobId: ${jobId}).`
  };
}

// ─── Generic adapter interface ────────────────────────────────────────────────

export const adapter = {
  name: "kilo",
  isAvailable: getKiloAvailability,
  isAuthenticated: getKiloAuthStatus,
  invoke: runAcpPromptKilo,
  cancel: interruptAcpPromptKilo,
  getSession: undefined
};
