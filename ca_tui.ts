// ─── CA TUI Module ──────────────────────────────────────
// Full-screen terminal UI for interactive mode.
// Layout:
//   ┌─ Conversation (scrollable) ───────────────────┐
//   │  user: message...                             │
//   │  ca: response text...                         │
//   │  ┌─ 🔧 tool ──────────────────────────────┐   │
//   │  │  ✓ result preview (0.3s)               │   │
//   │  └────────────────────────────────────────┘   │
//   ├─ Status ──────────────────────────────────────┤
//   │  model │ ~12K/1M ctx │ /home/.../ca │ master  │
//   ├─ Input (Ctrl+Enter to send, Esc+Esc to exit)──┤
//   │  > █                                         │
//   └───────────────────────────────────────────────┘

import type { ChatMessage, AgentConfig, UsageInfo } from "./ca_types.ts";
import type { ToolCall } from "./ca_types.ts";
import { buildToolDefs, executeTool } from "./ca_tools.ts";
import { chatCompletionStream, estimateMessagesTokens } from "./ca_client.ts";
import { buildSystemContent } from "./ca_agent.ts";

// ─── TUI Event Types ──────────────────────────────────

export interface TuiEvent {
  type: "text" | "tool_call" | "tool_result" | "tool_error" | "done" | "warning" | "error" | "aborted";
  content?: string;
  round?: number;
  toolId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolError?: boolean;
  diff?: string;
  usage?: UsageInfo;
  message?: string;
  messages?: ChatMessage[];
  needsRestart?: boolean;
}

export interface TuiRunResult {
  messages: ChatMessage[];
  needsRestart: boolean;
}

// ─── Streaming Agent Runner (for TUI) ─────────────────

export async function* runAgentStream(
  prompt: string,
  messages: ChatMessage[],
  config: AgentConfig,
  signal?: AbortSignal,
): AsyncGenerator<TuiEvent, TuiRunResult, void> {
  const tools = buildToolDefs(config);
  const systemContent = await buildSystemContent(config, Deno.cwd());

  const msgs = structuredClone(messages);
  if (msgs.length > 0 && msgs[0].role === "system") {
    msgs[0].content = systemContent;
  } else if (msgs.length === 0 || msgs[0].role !== "system") {
    msgs.unshift({ role: "system", content: systemContent });
  }

  msgs.push({ role: "user", content: prompt });

  for (let round = 1; round <= config.maxRounds; round++) {
    if (signal?.aborted) {
      yield { type: "aborted" };
      return { messages: msgs, needsRestart: false };
    }

    const estTokens = estimateMessagesTokens(msgs);
    if (estTokens > config.maxTokens * 0.9) {
      yield { type: "warning", message: `Token budget near limit: ~${estTokens}/${config.maxTokens}` };
    }
    if (estTokens > config.maxTokens) {
      yield { type: "error", message: `Token budget exceeded: ~${estTokens} > ${config.maxTokens}` };
      return { messages: msgs, needsRestart: false };
    }

    let response: ChatMessage;
    let usage: UsageInfo | undefined;

    // Build response from streaming
    const accum: {
      content: string;
      reasoning: string;
      toolCalls: Map<number, { id: string; name: string; args: string }>;
    } = { content: "", reasoning: "", toolCalls: new Map() };

    try {
      for await (const event of chatCompletionStream(msgs, tools, config)) {
        if (signal?.aborted) {
          yield { type: "aborted" };
          return { messages: msgs, needsRestart: false };
        }

        if (event.type === "reasoning") {
          accum.reasoning += event.content!;
        } else if (event.type === "content") {
          accum.content += event.content!;
          yield { type: "text", content: event.content!, round };
        } else if (event.type === "tool_call_start") {
          const tc = accum.toolCalls.get(event.toolIndex!) ?? { id: "", name: "", args: "" };
          tc.id = event.toolId!;
          tc.name = event.toolName ?? "";
          accum.toolCalls.set(event.toolIndex!, tc);
        } else if (event.type === "tool_call_delta") {
          const tc = accum.toolCalls.get(event.toolIndex!);
          if (tc) tc.args += event.toolArgs!;
        } else if (event.type === "done") {
          usage = event.usage;
        } else if (event.type === "error") {
          yield { type: "error", message: `API error: ${event.error}` };
          return { messages: msgs, needsRestart: false };
        }
      }
    } catch (e) {
      yield { type: "error", message: `API error: ${(e as Error).message}` };
      return { messages: msgs, needsRestart: false };
    }

    response = { role: "assistant", content: accum.content || null };
    if (accum.reasoning) response.reasoning_content = accum.reasoning;

    const toolCallsArr = [...accum.toolCalls.values()].filter((tc) => tc.id);
    if (toolCallsArr.length > 0) {
      response.tool_calls = toolCallsArr.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args },
      }));
    }

    msgs.push(response);

    // Execute tools
    if (response.tool_calls?.length) {
      // Phase 1: parse args, emit tool_call events
      interface ToolTask {
        tc: ToolCall;
        name: string;
        args: Record<string, unknown>;
      }
      const tasks: ToolTask[] = [];
      for (const tc of response.tool_calls) {
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments); } catch {
          yield { type: "tool_error", toolId: tc.id, toolName: name, message: "Invalid JSON arguments" };
          msgs.push({ role: "tool", tool_call_id: tc.id, content: "Error: Invalid JSON arguments" });
          continue;
        }
        yield { type: "tool_call", toolId: tc.id, toolName: name, toolArgs: args, round };
        tasks.push({ tc, name, args });
      }

      // Phase 2: execute all in parallel
      const results = await Promise.all(tasks.map(async ({ tc, name, args }) => {
        try {
          const r = await executeTool(name, args, {
            sandbox: config.sandbox,
            approve: config.approve,
            dryRun: config.dryRun,
            autoCommit: config.autoCommit,
            cwd: Deno.cwd(),
            askUser: undefined,
          });
          return { tc, result: r.output, error: r.output.startsWith("Error"), diff: r.diff };
        } catch (e) {
          return { tc, result: `Error: ${(e as Error).message}`, error: true };
        }
      }));

      // Phase 3: emit results
      for (const { tc, result, error, diff } of results) {
        yield { type: "tool_result", toolId: tc.id, toolName: tc.function.name, toolResult: result, toolError: error, diff, round };
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
        if (result === "RESTART_READY") {
          yield { type: "done", usage, messages: structuredClone(msgs), needsRestart: true };
          return { messages: msgs, needsRestart: true };
        }
      }

      if (config.dryRun) {
        yield { type: "done", usage, messages: structuredClone(msgs), needsRestart: false };
        return { messages: msgs, needsRestart: false };
      }
    } else {
      yield { type: "done", usage, messages: structuredClone(msgs), needsRestart: false };
      return { messages: msgs, needsRestart: false };
    }
  }

  yield { type: "warning", message: `Reached max rounds (${config.maxRounds})` };
  return { messages: msgs, needsRestart: false };
}

// ─── TUI Renderer ─────────────────────────────────────
// Layout (top to bottom):
//   lines 0..N-4: conversation (scrollable)
//   lines N-3:    separator
//   line  N-2:    status
//   line  N-1:    separator
//   lines N..end: input area

interface TuiLine {
  role?: "user" | "assistant" | "system" | "tool";
  text: string;
  toolId?: string;
  toolName?: string;
  toolCollapsed?: boolean;
}

const TOP_COLOR = "\x1b[36m";  // cyan
const USER_COLOR = "\x1b[32m"; // green
const TOOL_COLOR = "\x1b[33m"; // yellow
const ERR_COLOR = "\x1b[31m";  // red
const DIM_COLOR = "\x1b[2m";
const RESET = "\x1b[0m";
const REVERSE = "\x1b[7m";

function esc(code: string): string {
  return `\x1b[${code}`;
}

export class Tui {
  private messages: ChatMessage[] = [];
  private lines: TuiLine[] = [];
  private scrollOffset = 0;
  private width = 80;
  private height = 24;
  private statusModel = "";
  private statusCtx = "";
  private statusDir = "";
  private statusGit = "";
  private statusExtra = "";
  private inputBuf = "";
  private inputCursor = 0;
  private running = false;
  private aborted = false;
  private encoder = new TextEncoder();
  private spinnerFrame = 0;
  private spinnerInterval: number | null = null;
  private spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private dirty = true;
  private renderScheduled = false;

  constructor() {}

  async init(model: string, ctxTokens: string, dir: string, gitBranch: string) {
    this.statusModel = model;
    this.statusCtx = ctxTokens;
    this.statusDir = dir;
    this.statusGit = gitBranch;
    this.updateSize();
    Deno.stdin.setRaw(true);
    await Deno.stdout.write(this.encoder.encode(
      esc("?1049h") + esc("?25l") + esc("2J")
    ));
    this.render();
    Deno.addSignalListener("SIGWINCH", () => {
      this.updateSize();
      this.render();
    });
  }

  shutdown() {
    if (this.spinnerInterval) { clearInterval(this.spinnerInterval); this.spinnerInterval = null; }
    Deno.stdin.setRaw(false);
    Deno.stdout.writeSync(this.encoder.encode(
      esc("?25h") + esc("?1049l")
    ));
  }

  private updateSize() {
    try {
      this.height = Deno.consoleSize()?.rows ?? 24;
      this.width = Deno.consoleSize()?.columns ?? 80;
    } catch {
      this.height = 24;
      this.width = 80;
    }
  }

  setStatus(ctxTokens: string, extra?: string) {
    this.statusCtx = ctxTokens;
    this.statusExtra = extra ?? "";
  }

  setRunning(v: boolean) {
    this.running = v;
    this.aborted = false;
    if (v) {
      this.spinnerFrame = 0;
      this.spinnerInterval = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % this.spinnerChars.length;
        this.render();
      }, 80);
    } else {
      if (this.spinnerInterval) { clearInterval(this.spinnerInterval); this.spinnerInterval = null; }
      this.render();
    }
  }

  getAborted(): boolean { return this.aborted; }

  // ─── Input ──────────────────────────────────────────

  private escapeBytes: number[] = [];

  async readInput(): Promise<string | null> {
    this.inputBuf = "";
    this.inputCursor = 0;
    this.escapeBytes = [];
    this.render();

    const buf = new Uint8Array(64);
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) return null;

      for (let j = 0; j < n; j++) {
        const b = buf[j];

        // If we're collecting an escape sequence
        if (this.escapeBytes.length > 0) {
          this.escapeBytes.push(b);
          const s = new TextDecoder().decode(new Uint8Array(this.escapeBytes));

          // Check if we have a complete known sequence
          const known = [
            "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D",
            "\x1bOA", "\x1bOB", "\x1bOC", "\x1bOD",
            "\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F",
            "\x1b[1~", "\x1b[4~", "\x1b[3~",
          ];
          const match = known.find(k => k === s);
          if (match) {
            // Process the sequence
            if (match === "\x1b[A" || match === "\x1bOA") this.scrollOffset = Math.max(0, this.scrollOffset - 1);
            else if (match === "\x1b[B" || match === "\x1bOB") { const cl = this.getConversationLines(); this.scrollOffset = Math.min(Math.max(0, cl.length - (this.height - 4)), this.scrollOffset + 1); }
            else if (match === "\x1b[C" || match === "\x1bOC") { if (this.inputCursor < this.inputBuf.length) this.inputCursor++; }
            else if (match === "\x1b[D" || match === "\x1bOD") { if (this.inputCursor > 0) this.inputCursor--; }
            else if (match === "\x1b[5~") this.scrollOffset = Math.max(0, this.scrollOffset - 10);
            else if (match === "\x1b[6~") { const cl = this.getConversationLines(); this.scrollOffset = Math.min(Math.max(0, cl.length - (this.height - 4)), this.scrollOffset + 10); }
            else if (match === "\x1b[H") this.scrollOffset = 0;
            this.escapeBytes = [];
            this.render();
            continue;
          }

          // Check if it's a complete but unknown ESC sequence (length >= 3, starts with ESC [)
          if (this.escapeBytes.length >= 3 && s.startsWith("\x1b[")) {
            // Unknown but complete - discard it
            this.escapeBytes = [];
            continue;
          }

          // If we've buffered too many bytes, give up
          if (this.escapeBytes.length >= 6) {
            this.escapeBytes = [];
            continue;
          }
          // Otherwise keep buffering
          continue;
        }

        // Start of escape sequence
        if (b === 27) {
          this.escapeBytes = [27];
          continue;
        }

        // Regular key handling
        if (b === 24) { // Ctrl+X
          return this.inputBuf.trim() || null;
        }
        if (b === 10) { // Ctrl+J
          return this.inputBuf.trim() || null;
        }
        if (b === 13) { // Enter
          this.inputBuf = this.inputBuf.substring(0, this.inputCursor) + "\n" + this.inputBuf.substring(this.inputCursor);
          this.inputCursor++;
          this.render();
          continue;
        }
        if (b === 127 || b === 8) { // Backspace
          if (this.inputCursor > 0) {
            this.inputBuf = this.inputBuf.substring(0, this.inputCursor - 1) + this.inputBuf.substring(this.inputCursor);
            this.inputCursor--;
            this.render();
          }
          continue;
        }
        if (b === 9) { // Tab
          this.doAutoComplete();
          this.render();
          continue;
        }
        if (b === 23) { // Ctrl+W
          const before = this.inputBuf.substring(0, this.inputCursor);
          const after = this.inputBuf.substring(this.inputCursor);
          const m = before.match(/(.*\s+)?(\S*)$/);
          if (m) { const keep = m[1] ?? ""; this.inputBuf = keep + after; this.inputCursor = keep.length; }
          this.render();
          continue;
        }
        if (b === 21) { // Ctrl+U
          this.inputBuf = this.inputBuf.substring(this.inputCursor);
          this.inputCursor = 0;
          this.render();
          continue;
        }
        if (b >= 32 && b < 127) { // Printable ASCII
          const char = String.fromCharCode(b);
          this.inputBuf = this.inputBuf.substring(0, this.inputCursor) + char + this.inputBuf.substring(this.inputCursor);
          this.inputCursor++;
          this.render();
          continue;
        }
      }
    }
  }

  private doAutoComplete() {
    const beforeCursor = this.inputBuf.substring(0, this.inputCursor);
    // Command completion
    if (beforeCursor.startsWith("/")) {
      const commands = [
        "/help", "/quit", "/exit", "/new", "/clear", "/tokens", "/model",
        "/history", "/system", "/context", "/save", "/load", "/edit", "/set",
        "/upgrade", "/upgrade-go",
      ];
      const partial = beforeCursor.toLowerCase();
      const matches = commands.filter(c => c.startsWith(partial));
      if (matches.length === 1) {
        this.inputBuf = matches[0] + this.inputBuf.substring(this.inputCursor);
        this.inputCursor = matches[0].length;
      } else if (matches.length > 1) {
        // Show common prefix
        let common = matches[0];
        for (const m of matches) {
          let j = 0;
          while (j < common.length && j < m.length && common[j] === m[j]) j++;
          common = common.substring(0, j);
        }
        if (common.length > partial.length) {
          this.inputBuf = common + this.inputBuf.substring(this.inputCursor);
          this.inputCursor = common.length;
        }
      }
      return;
    }
    // File path completion (# prefix)
    const fileMatch = beforeCursor.match(/(^|.*\s)#(\S*)$/);
    if (fileMatch) {
      // Basic: don't do async file lookups in the UI thread
      // Just expand # to current directory for now
      if (fileMatch[2] === "") {
        try {
          const entries: string[] = [];
          for (const entry of Deno.readDirSync(".")) {
            if (!entry.name.startsWith(".")) {
              entries.push(entry.name + (entry.isDirectory ? "/" : ""));
            }
          }
          if (entries.length === 1) {
            const prefix = fileMatch[1];
            this.inputBuf = prefix + "#" + entries[0] + this.inputBuf.substring(this.inputCursor);
            this.inputCursor = (prefix + "#" + entries[0]).length;
          }
        } catch { /* ok */ }
      }
      return;
    }
  }

  // ─── Conversation ──────────────────────────────────

  addMessage(msg: ChatMessage) {
    this.messages.push(msg);
    this.rebuildLines();
    // Auto-scroll to bottom
    const convLines = this.getConversationLines();
    const convAvail = Math.max(1, this.height - 4);
    this.scrollOffset = Math.max(0, convLines.length - convAvail);
    this.render();
  }

  addTextChunk(text: string) {
    // Append to the last line if it's assistant text
    if (this.lines.length > 0 && this.lines[this.lines.length - 1].role === "assistant") {
      this.lines[this.lines.length - 1].text += text;
    } else {
      this.lines.push({ role: "assistant", text });
    }
    // Auto-scroll to bottom
    const convLines = this.getConversationLines();
    const convAvail = Math.max(1, this.height - 4);
    this.scrollOffset = Math.max(0, convLines.length - convAvail);
    this.render();
  }

  addToolCall(id: string, name: string, args: Record<string, unknown>) {
    const argsStr = JSON.stringify(args).substring(0, 80);
    this.lines.push({ role: "tool", text: `🔧 ${name} ${argsStr}`, toolId: id, toolName: name });
    this.render();
  }

  updateToolResult(id: string, result: string, isError: boolean) {
    for (const line of this.lines) {
      if (line.toolId === id && line.role === "tool") {
        const icon = isError ? "✘" : "✓";
        const preview = result.length > 100 ? result.substring(0, 100).replace(/\n/g, " ") + "..." : result.replace(/\n/g, " ");
        line.text = `${icon} ${line.toolName ?? ""} → ${preview}`;
        line.role = isError ? "tool" : "tool"; // could add tool_error role for coloring
        break;
      }
    }
    this.render();
  }

  addWarning(msg: string) {
    this.lines.push({ role: "system", text: `⚠ ${msg}` });
    this.render();
  }

  addError(msg: string) {
    this.lines.push({ role: "system", text: `✘ ${msg}` });
    this.render();
  }

  private rebuildLines() {
    this.lines = [];
    for (const msg of this.messages) {
      if (msg.role === "system") continue;
      if (msg.role === "user") {
        const text = msg.content ?? "";
        for (const line of text.split("\n")) {
          this.lines.push({ role: "user", text: line });
        }
      } else if (msg.role === "assistant") {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const argsStr = JSON.stringify(JSON.parse(tc.function.arguments || "{}")).substring(0, 80);
            this.lines.push({ role: "tool", text: `🔧 ${tc.function.name} ${argsStr}`, toolId: tc.id, toolName: tc.function.name });
          }
        }
        if (msg.content) {
          for (const line of msg.content.split("\n")) {
            this.lines.push({ role: "assistant", text: line });
          }
        }
      } else if (msg.role === "tool") {
        const preview = (msg.content ?? "").length > 100 ? (msg.content ?? "").substring(0, 100).replace(/\n/g, " ") + "..." : (msg.content ?? "").replace(/\n/g, " ");
        const isErr = (msg.content ?? "").startsWith("Error");
        this.lines.push({ role: "tool", text: `${isErr ? "✘" : "✓"} ${preview}` });
      }
    }
  }

  private getConversationLines(): string[] {
    const result: string[] = [];
    for (const line of this.lines) {
      // Wrap long lines
      const text = line.text;
      const maxW = this.width - 2;
      if (text.length <= maxW) {
        result.push(this.colorLine(line));
      } else {
        let remaining = text;
        while (remaining.length > 0) {
          const chunk = remaining.substring(0, maxW);
          remaining = remaining.substring(maxW);
          result.push(this.colorLine({ ...line, text: chunk }));
        }
      }
    }
    return result;
  }

  private colorLine(line: TuiLine): string {
    const prefix = line.role === "user" ? ` ${USER_COLOR}❯${RESET} ` :
                   line.role === "assistant" ? ` ${TOP_COLOR}●${RESET} ` :
                   line.role === "tool" && line.text.startsWith("✘") ? `  ` :
                   line.role === "tool" ? `  ` :
                   line.role === "system" ? `  ` : `  `;

    const color = line.role === "user" ? USER_COLOR :
                  line.role === "assistant" ? RESET :
                  line.role === "tool" && line.text.startsWith("✘") ? ERR_COLOR :
                  line.role === "tool" ? DIM_COLOR :
                  line.role === "system" ? ERR_COLOR : RESET;

    return `${prefix}${color}${line.text}${RESET}`;
  }

  // ─── Render ────────────────────────────────────────

  private scheduleRender() {
    if (!this.renderScheduled) {
      this.renderScheduled = true;
      queueMicrotask(() => {
        this.renderScheduled = false;
        if (this.dirty) this.renderNow();
      });
    }
  }

  render() {
    this.dirty = true;
    this.scheduleRender();
  }

  private renderNow() {
    this.dirty = false;
    const convLines = this.getConversationLines();
    const convAvail = Math.max(1, this.height - 4); // leave 2 for status, 2 for input
    const maxScroll = Math.max(0, convLines.length - convAvail);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScroll));

    // Auto-scroll to bottom if we're near the bottom
    if (this.scrollOffset >= maxScroll - 2) {
      this.scrollOffset = maxScroll;
    }

    const visibleConv = convLines.slice(
      this.scrollOffset,
      this.scrollOffset + convAvail,
    );

    // Pad conversation area
    const padLines = Math.max(0, convAvail - visibleConv.length);
    const padding: string[] = [];
    for (let i = 0; i < padLines; i++) padding.push("~".repeat(Math.min(this.width, 40)));

    // Status line
    const runningIndicator = this.running ? ` ${this.spinnerChars[this.spinnerFrame]}` : "";
    const extraStr = this.statusExtra ? ` ${this.statusExtra}` : "";
    const statusLeft = `${this.statusModel}${runningIndicator} │ ~${this.statusCtx} │ ${this.statusDir}${this.statusGit ? " │ " + this.statusGit : ""}`;
    const statusRight = extraStr || (this.running ? "Ctrl+C to cancel" : "Ctrl+X send  ↑↓ scroll  /commands");
    const statusPad = Math.max(1, this.width - statusLeft.length - statusRight.length - 1);
    const statusLine = `${REVERSE}${TOP_COLOR} ${statusLeft}${" ".repeat(statusPad)}${DIM_COLOR}${statusRight} ${RESET}`;

    // Input area (2 lines, bottom-justified)
    const inputLines = this.inputBuf.split("\n");
    const inputAvail = 2;
    const visibleInput = inputLines.slice(-inputAvail);
    while (visibleInput.length < inputAvail) visibleInput.unshift("");

    // Current line index within the visible input (0 = top, 1 = bottom)
    const currentLineIdx = Math.min(inputLines.length - 1, inputAvail - 1);
    const currentLineText = visibleInput[currentLineIdx] ?? "";
    const cursorInLine = (inputLines.length <= inputAvail)
      ? this.inputCursor  // all lines visible
      : this.inputCursor; // last 2 lines shown, cursor is in the last line

    const inputRendered = visibleInput.map((l, i) => {
      const isCurrentLine = i === currentLineIdx;
      const prefix = i === 0 ? `${DIM_COLOR}❯${RESET} ` : "  ";
      if (isCurrentLine && this.inputCursor >= 0) {
        const before = l.substring(0, this.inputCursor);
        const at = l[this.inputCursor] || " ";
        const after = l.substring(this.inputCursor + 1);
        return `${prefix}${before}${REVERSE}${at}${RESET}${after}`;
      }
      return `${DIM_COLOR}${prefix}${RESET}${l}`;
    }).join("\n");

    // Assemble
    const out = [
      ...visibleConv,
      ...padding.map(p => DIM_COLOR + p + RESET),
      statusLine,
      DIM_COLOR + "─".repeat(Math.min(this.width, 80)) + RESET,
      inputRendered,
    ].join("\n");

    // Move cursor to top-left and redraw (avoids full clear flicker)
    Deno.stdout.writeSync(this.encoder.encode(
      esc("H") + out + esc("J")
    ));
  }
}
