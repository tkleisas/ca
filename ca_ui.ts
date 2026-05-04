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

export function printBanner(config: AgentConfig): void {
  const isTerminal = Deno.stderr.isTerminal();
  const line = isTerminal ? "─".repeat(52) : "────────────────────────────────────────────────────";
  console.error(
    isTerminal ? `\n${colorize(line, C.dim)}` : `\n${line}`,
  );
  console.error(
    `${colorize(bold(`CA 0.1.0`), C.cyan)} ${dim("— Self-Evolving Coding Agent")}`,
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
