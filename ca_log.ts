import type { ChatMessage, UsageInfo } from "./ca_types.ts";

// ─── Debug Logger ───────────────────────────────────────
// Writes full messages, tool calls, and results to a log file.
// Controlled by CA_DEBUG_LOG=1 env var.
// Output: .ca/logs/ca_YYYY-MM-DD_HH-MM-SS.log (JSON Lines)

let _logger: DebugLogger | null = null;

export interface LogEntry {
  ts: string;            // ISO timestamp
  type: string;          // event type
  [key: string]: unknown;
}

export class DebugLogger {
  private encoder = new TextEncoder();
  private file: Deno.FsFile | null = null;
  private buf = "";
  private flushTimer: number | null = null;
  private path: string;

  constructor(cwd: string) {
    const ts = new Date().toISOString()
      .replace(/[:.]/g, "-")
      .substring(0, 19);
    this.path = `${cwd}/.ca/logs/ca_${ts}.log`;
  }

  async init(): Promise<void> {
    try {
      await Deno.mkdir(this.path.substring(0, this.path.lastIndexOf("/")), {
        recursive: true,
      });
      this.file = await Deno.open(this.path, {
        write: true,
        create: true,
        append: true,
      });
    } catch {
      // Silently fail — logging is optional
    }
  }

  log(entry: LogEntry): void {
    if (!this.file) return;
    entry.ts = entry.ts ?? new Date().toISOString();
    const line = JSON.stringify(entry) + "\n";
    this.buf += line;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, 250);
  }

  private flushNow(): void {
    if (!this.file || !this.buf) return;
    try {
      this.file.writeSync(this.encoder.encode(this.buf));
      this.buf = "";
    } catch {
      // Silently fail
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushNow();
    try {
      this.file?.close();
    } catch { /* ok */ }
    this.file = null;
  }

  getPath(): string {
    return this.path;
  }
}

// ─── Singleton access ──────────────────────────────────

export function isDebugLogEnabled(): boolean {
  const v = Deno.env.get("CA_DEBUG_LOG");
  return v === "1" || v === "true";
}

export async function initDebugLog(cwd: string): Promise<DebugLogger | null> {
  if (!isDebugLogEnabled()) return null;
  if (_logger) return _logger;
  _logger = new DebugLogger(cwd);
  await _logger.init();
  return _logger;
}

export function getDebugLog(): DebugLogger | null {
  return _logger;
}

export async function closeDebugLog(): Promise<void> {
  if (_logger) {
    await _logger.close();
    _logger = null;
  }
}

// ─── Convenience helpers ────────────────────────────────

export function logRound(
  logger: DebugLogger | null,
  round: number,
  maxRounds: number,
  estTokens: number,
  maxTokens: number,
  effectiveMaxOutput: number,
): void {
  if (!logger) return;
  logger.log({
    type: "round",
    round,
    maxRounds,
    estTokens,
    maxTokens,
    pct: ((estTokens / maxTokens) * 100).toFixed(1),
    effectiveMaxOutput,
  });
}

export function logMessagesSent(
  logger: DebugLogger | null,
  round: number,
  messages: ChatMessage[],
): void {
  if (!logger) return;
  logger.log({
    type: "messages_sent",
    round,
    count: messages.length,
    messages,
  });
}

export function logResponse(
  logger: DebugLogger | null,
  round: number,
  message: ChatMessage,
  usage?: UsageInfo,
): void {
  if (!logger) return;
  logger.log({
    type: "response",
    round,
    message,
    usage: usage ?? null,
  });
}

export function logToolCall(
  logger: DebugLogger | null,
  round: number,
  id: string,
  name: string,
  args: Record<string, unknown>,
): void {
  if (!logger) return;
  logger.log({
    type: "tool_call",
    round,
    id,
    name,
    args,
  });
}

export function logToolResult(
  logger: DebugLogger | null,
  round: number,
  id: string,
  name: string,
  result: string,
  isError: boolean,
): void {
  if (!logger) return;
  logger.log({
    type: "tool_result",
    round,
    id,
    name,
    result,
    isError,
  });
}

export function logCompaction(
  logger: DebugLogger | null,
  beforeCount: number,
  beforeTokens: number,
  afterCount: number,
  afterTokens: number,
): void {
  if (!logger) return;
  logger.log({
    type: "compaction",
    beforeMessages: beforeCount,
    beforeTokens,
    afterMessages: afterCount,
    afterTokens,
  });
}

export function logError(
  logger: DebugLogger | null,
  round: number,
  error: string,
): void {
  if (!logger) return;
  logger.log({
    type: "error",
    round,
    error,
  });
}

export function logSessionStart(
  logger: DebugLogger | null,
  model: string,
  apiBase: string,
  maxTokens: number,
  maxOutputTokens: number,
  cwd: string,
): void {
  if (!logger) return;
  logger.log({
    type: "session_start",
    model,
    apiBase,
    maxTokens,
    maxOutputTokens,
    cwd,
  });
}
