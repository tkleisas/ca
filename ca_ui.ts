// ─── ANSI Colors ───────────────────────────────────────

export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
  bgGray: "\x1b[100m",
} as const;

export function colorize(text: string, color: string): string {
  if (!Deno.stderr.isTerminal()) return text;
  return `${color}${text}${C.reset}`;
}

export function dim(text: string): string {
  return colorize(text, C.dim);
}

export function bold(text: string): string {
  return colorize(text, C.bold);
}

export function italic(text: string): string {
  return colorize(text, C.italic);
}

export function underline(text: string): string {
  return colorize(text, C.underline);
}

// ─── Spinner ───────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private interval: number | null = null;
  private frame = 0;
  private message = "";
  private running = false;

  start(msg: string): void {
    if (!Deno.stderr.isTerminal()) {
      console.error(`[ca] ${msg}`);
      return;
    }
    this.message = msg;
    this.frame = 0;
    this.running = true;
    this.render();
    this.interval = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, 80);
  }

  private render(): void {
    if (!this.running) return;
    const spinner = SPINNER_FRAMES[this.frame];
    Deno.stderr.writeSync(
      new TextEncoder().encode(
        `\r${colorize(spinner, C.cyan)} ${dim(this.message)}`,
      ),
    );
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.running = false;
    if (Deno.stderr.isTerminal()) {
      Deno.stderr.writeSync(new TextEncoder().encode("\r\x1b[K"));
    }
  }

  succeed(msg: string): void {
    this.stop();
    console.error(`${colorize("✔", C.green)} ${dim(msg)}`);
  }

  fail(msg: string): void {
    this.stop();
    console.error(`${colorize("✘", C.red)} ${dim(msg)}`);
  }

  warn(msg: string): void {
    this.stop();
    console.error(`${colorize("⚠", C.yellow)} ${dim(msg)}`);
  }

  update(msg: string): void {
    this.message = msg;
    if (!this.running) return;
    if (Deno.stderr.isTerminal()) {
      const spinner = SPINNER_FRAMES[this.frame];
      Deno.stderr.writeSync(
        new TextEncoder().encode(
          `\r${colorize(spinner, C.cyan)} ${dim(msg)}`,
        ),
      );
    }
  }
}

// ─── Banner ────────────────────────────────────────────

import type { AgentConfig } from "./ca_types.ts";
import { VERSION } from "./ca_types.ts";

export function printBanner(config: AgentConfig): void {
  const isTerminal = Deno.stderr.isTerminal();
  const line = isTerminal ? "─".repeat(52) : "────────────────────────────────────────────────────";
  console.error(
    isTerminal ? `\n${colorize(line, C.dim)}` : `\n${line}`,
  );
  console.error(
    `${colorize(bold(`CA ${VERSION}`), C.cyan)} ${dim("— Self-Evolving Coding Agent")}`,
  );
  console.error(
    `${dim("Model:")} ${config.model}  ${dim("Base:")} ${config.apiBase}`,
  );
  const flags: string[] = [];
  if (config.thinking) flags.push("thinking");
  if (config.reasoningEffort) flags.push(`reasoning:${config.reasoningEffort}`);
  if (config.sandbox) flags.push("sandbox");
  if (config.approve) flags.push("approve");
  if (config.dryRun) flags.push("dry-run");
  if (config.stream) flags.push("stream");
  if (flags.length) console.error(`${dim("Flags:")} ${flags.join(", ")}`);
  console.error(
    isTerminal ? `${colorize(line, C.dim)}` : `${line}`,
  );
  console.error("");
}

// ─── Tool Display ──────────────────────────────────────

export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const displayArgs = { ...args };
  // Truncate content fields for display
  if (typeof displayArgs.content === "string" && displayArgs.content.length > 60) {
    displayArgs.content = (displayArgs.content as string).substring(0, 60) + "...";
  }
  const argsStr = JSON.stringify(displayArgs, null, 2);
  const icon =
    name === "read_file" ? "📖" :
    name === "write_file" ? "✏️" :
    name === "search_files" ? "🔍" :
    name === "list_directory" ? "📁" :
    name === "run_command" ? "⚡" :
    name === "ask_user" ? "💬" :
    name === "apply_diff" ? "📝" : "🔧";
  return `  ${icon} ${colorize(bold(name), C.cyan)} ${dim(argsStr)}`;
}

export function formatToolResult(result: string): string {
  const lines = result.split("\n").length;
  const isError = result.startsWith("Error");
  const statusColor = isError ? C.red : C.green;
  return `  ${colorize("↳", statusColor)} ${dim(`${result.length} bytes, ${lines} lines`)}`;
}

// ─── Syntax Highlighting (basic) ──────────────────────

export function highlightCode(code: string, lang?: string): string {
  // Strip existing ANSI codes for safety
  code = code.replace(/\x1b\[[0-9;]*m/g, "");

  const lines = code.split("\n");
  const result: string[] = [];
  let inBlock = false;
  let blockLang = "";

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (!inBlock) {
        inBlock = true;
        blockLang = line.substring(3).trim();
        result.push(colorize(line, C.dim));
      } else {
        inBlock = false;
        result.push(colorize(line, C.dim));
      }
    } else if (inBlock) {
      // Basic syntax highlighting inside code blocks
      result.push(highlightCodeLine(line, blockLang));
    } else {
      result.push(line);
    }
  }
  return result.join("\n");
}

function highlightCodeLine(line: string, lang: string): string {
  // Keywords for common languages
  const keywords = new Set([
    "import", "export", "from", "const", "let", "var", "function",
    "return", "if", "else", "for", "while", "do", "switch", "case",
    "break", "continue", "class", "extends", "new", "this", "super",
    "try", "catch", "finally", "throw", "async", "await", "yield",
    "type", "interface", "enum", "implements", "private", "public",
    "protected", "static", "readonly", "abstract", "def", "fn", "pub",
    "mod", "use", "struct", "impl", "match", "where", "mut", "ref",
  ]);

  // String literals
  line = line.replace(
    /(["'`])(?:(?=(\\?))\2.)*?\1/g,
    (m) => colorize(m, C.green),
  );

  // Comments
  if (line.match(/^\s*\/\//)) {
    return colorize(line, C.dim + C.italic);
  }
  line = line.replace(
    /\/\/.*$/,
    (m) => colorize(m, C.dim + C.italic),
  );

  // Keywords (word boundaries)
  for (const kw of keywords) {
    const re = new RegExp(`\\b${kw}\\b`, "g");
    line = line.replace(re, colorize(kw, C.magenta));
  }

  // Numbers
  line = line.replace(
    /\b\d+\.?\d*\b/g,
    (m) => colorize(m, C.yellow),
  );

  return line;
}

// ─── Approval Prompt ───────────────────────────────────

export async function promptYesNo(question: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  await Deno.stderr.write(encoder.encode(`\n${colorize("?", C.yellow)} ${question} ${dim("[y/N]")} `));

  const buf = new Uint8Array(256);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;

  const answer = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// ─── Separator ─────────────────────────────────────────

export function separator(char = "─", len = 52): string {
  const isTerminal = Deno.stderr.isTerminal();
  const line = char.repeat(len);
  return isTerminal ? colorize(line, C.dim) : line;
}

// ─── Error Formatting Helper ────────────────────────────

export function formatError(msg: string): string {
  return `${colorize("✘", C.red)} ${bold("Error:")} ${msg}`;
}

export function formatWarning(msg: string): string {
  return `${colorize("⚠", C.yellow)} ${bold("Warning:")} ${msg}`;
}

// ─── Readline with History ──────────────────────────────

/**
 * VT100-aware readline with history, multi-line continuation,
 * and arrow-key navigation. Works in raw mode.
 *
 * Usage:
 *   const rl = new Readline(1000);
 *   const line = await rl.readLine("❯ ");
 *   // Enter to submit, \\ at end-of-line + Enter to continue
 *   // Up/Down for history, Left/Right for cursor
 */
export class Readline {
  private history: string[] = [];
  private histIdx = -1;
  private maxHistory: number;
  private raw: boolean | null = null;

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
  }

  /** Enable raw mode */
  private async ensureRaw(): Promise<void> {
    if (!Deno.stdin.isTerminal()) return;
    if (this.raw === null) {
      this.raw = true;
      Deno.stdin.setRaw(true);
    }
  }

  /** Disable raw mode */
  restore(): void {
    if (this.raw === true && Deno.stdin.isTerminal()) {
      Deno.stdin.setRaw(false);
      this.raw = false;
    }
  }

  /** Read a single line with editing. Returns null on EOF. */
  async readLine(prompt: string): Promise<string | null> {
    if (!Deno.stdin.isTerminal()) {
      return this.readLineBuffered(prompt);
    }
    await this.ensureRaw();

    const encoder = new TextEncoder();
    const buf = new Uint8Array(64);

    let line = "";
    let cursor = 0;
    let savedLine = "";
    this.histIdx = this.history.length;

    const writePrompt = () => {
      Deno.stderr.writeSync(encoder.encode(`\r\x1b[K${prompt}${line}`));
      if (cursor < line.length) {
        const back = line.length - cursor;
        Deno.stderr.writeSync(encoder.encode(`\x1b[${back}D`));
      }
    };

    writePrompt();

    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) return null;

      const seq = buf.subarray(0, n);

      // Enter (CR or LF)
      if (n === 1 && (seq[0] === 13 || seq[0] === 10)) {
        // Check for continuation: line ends with backslash
        if (line.endsWith("\\") && !line.endsWith("\\\\")) {
          // Multi-line continuation
          this.history.push(line.slice(0, -1) + "\n");
          if (this.history.length > this.maxHistory) this.history.shift();
          this.histIdx = this.history.length;
          savedLine += line.slice(0, -1) + "\n";
          line = "";
          cursor = 0;
          Deno.stderr.writeSync(encoder.encode("\n"));
          writePrompt();
          continue;
        }
        Deno.stderr.writeSync(encoder.encode("\n"));
        const full = savedLine + line;
        if (full.trim()) {
          this.history.push(full);
          if (this.history.length > this.maxHistory) this.history.shift();
        }
        return full;
      }

      // Ctrl+C
      if (n === 1 && seq[0] === 3) {
        Deno.stderr.writeSync(encoder.encode("^C\n"));
        return "";
      }

      // Ctrl+D (EOF)
      if (n === 1 && seq[0] === 4) {
        Deno.stderr.writeSync(encoder.encode("\n"));
        if (savedLine + line) {
          const full = savedLine + line;
          this.history.push(full);
          if (this.history.length > this.maxHistory) this.history.shift();
          return full;
        }
        return null;
      }

      // Backspace / Ctrl+H
      if (n === 1 && (seq[0] === 127 || seq[0] === 8)) {
        if (cursor > 0) {
          line = line.substring(0, cursor - 1) + line.substring(cursor);
          cursor--;
          writePrompt();
        }
        continue;
      }

      // Ctrl+W (delete word)
      if (n === 1 && seq[0] === 23) {
        const before = line.substring(0, cursor);
        const after = line.substring(cursor);
        const m = before.match(/(.*\s+)?(\S*)$/);
        if (m) {
          const keep = m[1] ?? "";
          line = keep + after;
          cursor = keep.length;
        }
        writePrompt();
        continue;
      }

      // Ctrl+U (delete to start)
      if (n === 1 && seq[0] === 21) {
        line = line.substring(cursor);
        cursor = 0;
        writePrompt();
        continue;
      }

      // Ctrl+A (home)
      if (n === 1 && seq[0] === 1) {
        cursor = 0;
        writePrompt();
        continue;
      }

      // Ctrl+E (end)
      if (n === 1 && seq[0] === 5) {
        cursor = line.length;
        writePrompt();
        continue;
      }

      // Arrow keys and other VT100 sequences
      if (seq[0] === 27 && n >= 3) {
        const s = new TextDecoder().decode(seq);
        // Up arrow
        if (s === "\x1b[A" || s === "\x1bOA") {
          if (this.histIdx > 0) {
            if (this.histIdx === this.history.length) {
              // Save current line before navigating
              (this as unknown as Record<string, string>)._savedLine = line;
            }
            this.histIdx--;
            line = this.history[this.histIdx];
            cursor = line.length;
            writePrompt();
          }
          continue;
        }
        // Down arrow
        if (s === "\x1b[B" || s === "\x1bOB") {
          if (this.histIdx < this.history.length - 1) {
            this.histIdx++;
            line = this.history[this.histIdx];
            cursor = line.length;
            writePrompt();
          } else if (this.histIdx === this.history.length - 1 && line) {
            this.histIdx = this.history.length;
            line = "";
            cursor = 0;
            writePrompt();
          }
          continue;
        }
        // Right arrow
        if (s === "\x1b[C" || s === "\x1bOC") {
          if (cursor < line.length) {
            cursor++;
            Deno.stderr.writeSync(encoder.encode("\x1b[1C"));
          }
          continue;
        }
        // Left arrow
        if (s === "\x1b[D" || s === "\x1bOD") {
          if (cursor > 0) {
            cursor--;
            Deno.stderr.writeSync(encoder.encode("\x1b[1D"));
          }
          continue;
        }
        // Home
        if (s === "\x1b[H" || s === "\x1b[1~") {
          cursor = 0;
          writePrompt();
          continue;
        }
        // End
        if (s === "\x1b[F" || s === "\x1b[4~") {
          cursor = line.length;
          writePrompt();
          continue;
        }
        // Del
        if (s === "\x1b[3~") {
          if (cursor < line.length) {
            line = line.substring(0, cursor) + line.substring(cursor + 1);
            writePrompt();
          }
          continue;
        }
        continue;
      }

      // Tab: insert two spaces
      if (n === 1 && seq[0] === 9) {
        line = line.substring(0, cursor) + "  " + line.substring(cursor);
        cursor += 2;
        writePrompt();
        continue;
      }

      // Printable characters
      const s = new TextDecoder().decode(seq);
      if (s.length === 1 && s.charCodeAt(0) >= 32) {
        line = line.substring(0, cursor) + s + line.substring(cursor);
        cursor++;
        writePrompt();
      }
    }
  }

  /** Read multiple lines; Enter alone submits */
  async readMultiLine(): Promise<string | null> {
    const lines: string[] = [];
    let firstLine = true;

    while (true) {
      const promptStr = firstLine
        ? colorize("❯ ", C.cyan)
        : colorize("│ ", dim(""));

      const line = await this.readLine(promptStr);
      firstLine = false;

      if (line === null) return lines.length > 0 ? lines.join("\n") : null;

      if (lines.length === 0 && line.trim() === "") return "";

      // Backslash at EOL = continue
      if (line.endsWith("\\") && !line.endsWith("\\\\")) {
        lines.push(line.slice(0, -1).trimEnd());
        continue;
      }

      lines.push(line);
      return lines.join("\n");
    }
  }

  /** Fallback for non-TTY */
  private async readLineBuffered(_prompt: string): Promise<string | null> {
    const buf = new Uint8Array(4096);
    const decoder = new TextDecoder();
    let data = "";
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) return data || null;
      data += decoder.decode(buf.subarray(0, n));
      const nl = data.indexOf("\n");
      if (nl !== -1) {
        const line = data.substring(0, nl);
        return line.replace(/\r$/, "");
      }
    }
  }
}
