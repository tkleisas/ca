import type { ToolDef, AgentConfig, ToolExecResult } from "./ca_types.ts";
import { C, colorize, dim, bold } from "./ca_ui.ts";
import { isPathSafe, isCommandSafe } from "./ca_sandbox.ts";

// ─── Tool Definitions ─────────────────────────────────

export function buildToolDefs(config: AgentConfig): ToolDef[] {
  const defs: ToolDef[] = [];

  if (config.tools.read_file) {
    defs.push({
      type: "function",
      function: {
        name: "read_file",
        description: "Read the contents of a file at the given path",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or relative path to the file" },
          },
          required: ["path"],
        },
      },
    });
  }

  if (config.tools.write_file) {
    defs.push({
      type: "function",
      function: {
        name: "write_file",
        description:
          "Write content to a file. Creates it if it doesn't exist, overwrites if it does. Parent directories are created automatically. If git auto-commit is enabled, a snapshot is saved before the write and a colored diff is shown after.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to write the file to" },
            content: { type: "string", description: "Content to write to the file" },
          },
          required: ["path", "content"],
        },
      },
    });
  }

  if (config.tools.run_command) {
    defs.push({
      type: "function",
      function: {
        name: "run_command",
        description: "Execute a bash shell command. Returns combined stdout+stderr with exit code. Commands timeout after 120s.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" },
            workdir: { type: "string", description: "Optional working directory. Defaults to current directory." },
          },
          required: ["command"],
        },
      },
    });
  }

  if (config.tools.search_files) {
    defs.push({
      type: "function",
      function: {
        name: "search_files",
        description: "Search for a regex pattern in files. Uses ripgrep if available, falls back to grep. Returns matching lines with file paths and line numbers.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern to search for" },
            path: { type: "string", description: "Directory or file to search in. Defaults to current directory." },
            glob: { type: "string", description: "File glob pattern to filter (e.g. '*.ts', '*.{js,ts}')." },
            maxResults: { type: "number", description: "Maximum number of results to return. Defaults to 50." },
          },
          required: ["pattern"],
        },
      },
    });
  }

  if (config.tools.list_directory) {
    defs.push({
      type: "function",
      function: {
        name: "list_directory",
        description: "List the contents of a directory. Shows files and subdirectories with their sizes.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path. Defaults to current directory." },
            depth: { type: "number", description: "Recursion depth (1-5). Defaults to 1." },
          },
          required: [],
        },
      },
    });
  }

  if (config.tools.ask_user) {
    defs.push({
      type: "function",
      function: {
        name: "ask_user",
        description: "Ask the user a clarifying question. Use when you need to make a decision with multiple reasonable options or need additional context.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question to ask the user. Be specific and concise." },
          },
          required: ["question"],
        },
      },
    });
  }

  if (config.tools.apply_diff) {
    defs.push({
      type: "function",
      function: {
        name: "apply_diff",
        description: "Apply a targeted change to a file using search-and-replace. The SEARCH block must match exactly once. Preferred over write_file for small edits to large files. If git auto-commit is enabled, a snapshot is saved and a colored diff is shown.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to the file to modify" },
            search: { type: "string", description: "Exact text to find. Must match exactly once, including whitespace." },
            replace: { type: "string", description: "Text to replace the search block with." },
          },
          required: ["path", "search", "replace"],
        },
      },
    });
  }

  if (config.tools.restart_self) {
    defs.push({
      type: "function",
      function: {
        name: "restart_self",
        description: "Restart CA with a new version of itself. Saves the current conversation, runs verification (deno check + tests), spawns a new CA process, and exits. Use after making verified improvements to ca.ts or ca_*.ts files.",
        parameters: {
          type: "object",
          properties: {
            confirm: { type: "boolean", description: "Must be true to confirm. Safety guard against accidental restarts." },
          },
          required: ["confirm"],
        },
      },
    });
  }

  return defs;
}

// ─── Tool Execution ────────────────────────────────────

export type AskUserCallback = (question: string) => Promise<string>;

export interface ToolExecOptions {
  sandbox: boolean;
  approve: boolean;
  dryRun: boolean;
  autoCommit: boolean;
  cwd: string;
  askUser?: AskUserCallback;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  opts: ToolExecOptions,
): Promise<ToolExecResult> {
  switch (name) {
    case "read_file":       return execReadFile(args.path as string, opts);
    case "write_file":      return execWriteFile(args.path as string, args.content as string, opts);
    case "run_command":     return execRunCommand(args.command as string, args.workdir as string | undefined, opts);
    case "search_files":    return execSearchFiles(args.pattern as string, args.path as string | undefined, args.glob as string | undefined, (args.maxResults as number) ?? 50, opts);
    case "list_directory":  return execListDirectory(args.path as string | undefined, (args.depth as number) ?? 1, opts);
    case "ask_user":        return execAskUser(args.question as string, opts);
    case "apply_diff":      return execApplyDiff(args.path as string, args.search as string, args.replace as string, opts);
    case "restart_self":    return execRestartSelf(args.confirm as boolean, opts);
    default:                return { output: `Unknown tool: ${name}`, error: true };
  }
}

// ─── Input Validation Helpers ──────────────────────────

function requireString(val: unknown, name: string): string | null {
  if (typeof val !== "string" || !val) return `Error: ${name} is required and must be a non-empty string`;
  return null;
}

function requireBoolean(val: unknown, name: string): string | null {
  if (typeof val !== "boolean") return `Error: ${name} must be a boolean`;
  return null;
}

function requireNumber(val: unknown, name: string, min?: number, max?: number): string | null {
  if (typeof val !== "number" || isNaN(val)) return `Error: ${name} must be a number`;
  if (min !== undefined && val < min) return `Error: ${name} must be >= ${min}`;
  if (max !== undefined && val > max) return `Error: ${name} must be <= ${max}`;
  return null;
}

// ─── Individual Executors ──────────────────────────────

async function execReadFile(path: string, opts: ToolExecOptions): Promise<ToolExecResult> {
  const err = requireString(path, "path");
  if (err) return { output: err, error: true };
  const safety = isPathSafe(path, opts.cwd, opts.sandbox);
  if (!safety.safe) return { output: `Error: ${safety.reason}`, error: true };
  if (opts.dryRun) return { output: `[dry-run] Would read file: ${path}`, error: false };

  try {
    const content = await Deno.readTextFile(path);
    const maxLen = 50000; // Limit output to avoid context explosion
    const truncated = content.length > maxLen
      ? content.substring(0, maxLen) + `\n...[truncated at ${maxLen} bytes, total ${content.length} bytes]`
      : content;
    const lines = truncated.split("\n");
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(4, " ")}| ${line}`);
    return { output: numbered.join("\n"), error: false };
  } catch (e) {
    return { output: `Error reading file: ${(e as Error).message}`, error: true };
  }
}

async function execWriteFile(path: string, content: string, opts: ToolExecOptions): Promise<ToolExecResult> {
  const pathErr = requireString(path, "path");
  if (pathErr) return { output: pathErr, error: true };
  if (content === undefined || content === null || typeof content !== "string") return { output: "Error: content is required and must be a string", error: true };

  const safety = isPathSafe(path, opts.cwd, opts.sandbox);
  if (!safety.safe) return { output: `Error: ${safety.reason}`, error: true };

  if (opts.approve) {
    const preview = content.length > 200 ? content.substring(0, 200) + "..." : content;
    console.error(`\n${colorize("✏️", C.yellow)} ${bold("write_file")} to ${colorize(path, C.white)}`);
    console.error(dim(`   Preview: ${preview}`));
    const { promptYesNo } = await import("./ca_ui.ts");
    if (!await promptYesNo(`Write ${content.length} bytes to ${path}?`)) {
      return { output: `User declined write to ${path}`, error: false };
    }
  }

  if (opts.dryRun) return { output: `[dry-run] Would write ${content.length} bytes to: ${path}`, error: false };

  // Read old content for diff before writing
  let oldContent: string | null = null;
  try { oldContent = await Deno.readTextFile(path); } catch { /* new file */ }

  // Git auto-snapshot
  if (opts.autoCommit && oldContent !== null) {
    const hash = await gitSnapshot(path, opts.cwd);
    if (hash) console.error(`  ${colorize("📸", C.dim)} ${dim(`git snapshot: ${hash}`)}`);
  }

  try {
    const lastSep = path.lastIndexOf("/");
    if (lastSep > 0) await Deno.mkdir(path.substring(0, lastSep), { recursive: true });
    await Deno.writeTextFile(path, content);

    // Show colored diff
    const diff = await computeDiff(path, oldContent, content, opts.cwd);
    if (diff) console.error(diff);

    // Run TypeScript check for .ts files
    const tsCheck = await checkTypeScript(path, opts.cwd);
    if (tsCheck) console.error(tsCheck);

    const existed = oldContent !== null;
    const checkInfo = tsCheck ? `\n${tsCheck}` : "";
    return {
      output: (existed
        ? `Successfully overwrote ${path} with ${content.length} bytes`
        : `Successfully created ${path} with ${content.length} bytes`) + checkInfo,
      error: false,
      diff: diff || undefined,
    };
  } catch (e) {
    return { output: `Error writing file: ${(e as Error).message}`, error: true };
  }
}

async function execRunCommand(command: string, workdir: string | undefined, opts: ToolExecOptions): Promise<ToolExecResult> {
  const err = requireString(command, "command");
  if (err) return { output: err, error: true };

  const safety = isCommandSafe(command);
  if (!safety.safe) {
    if (opts.approve) {
      const { promptYesNo } = await import("./ca_ui.ts");
      console.error(`\n${colorize("⚠", C.yellow)} ${bold("Potentially dangerous command:")} ${dim(safety.reason ?? "Unknown")}`);
      console.error(`   ${dim(command)}`);
      if (!await promptYesNo("Execute anyway?")) return { output: `User declined to run: ${command}`, error: false };
    } else {
      return { output: `Error: Command blocked: ${safety.reason}. Use --approve to override.`, error: true };
    }
  }

  const cwd = workdir ?? opts.cwd;
  if (workdir) {
    const dirSafety = isPathSafe(workdir, opts.cwd, opts.sandbox);
    if (!dirSafety.safe) return { output: `Error: Working directory: ${dirSafety.reason}`, error: true };
  }

  if (opts.dryRun) return { output: `[dry-run] Would run: ${command} (in ${cwd})`, error: false };

  try {
    const cmd = new Deno.Command("bash", { args: ["-c", command], cwd, stdout: "piped", stderr: "piped", env: Deno.env.toObject() });
    const proc = cmd.spawn();

    // Enforce 120s timeout
    const timeoutMs = 120_000;
    const timeout = setTimeout(async () => {
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    }, timeoutMs);

    let output: Deno.CommandOutput;
    try {
      output = await proc.output();
    } finally {
      clearTimeout(timeout);
    }

    const { code, stdout, stderr } = output;
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    let result = "";
    if (out) result += out;
    if (err) result += (result ? "\n" : "") + err;
    if (code === null) {
      result += `\n[timeout after ${timeoutMs / 1000}s]`;
    } else {
      result += `\n[exit: ${code}]`;
    }
    if (result.length > 10000) result = result.substring(0, 10000) + "\n...[truncated]";
    return { output: result, error: code !== 0 };
  } catch (e) {
    return { output: `Error running command: ${(e as Error).message}`, error: true };
  }
}

async function execSearchFiles(pattern: string, path: string | undefined, glob: string | undefined, maxResults: number, opts: ToolExecOptions): Promise<ToolExecResult> {
  const err = requireString(pattern, "pattern");
  if (err) return { output: err, error: true };
  const searchPath = path ?? opts.cwd;
  const safety = isPathSafe(searchPath, opts.cwd, opts.sandbox);
  if (!safety.safe) return { output: `Error: ${safety.reason}`, error: true };
  if (opts.dryRun) return { output: `[dry-run] Would search for "${pattern}" in ${searchPath}`, error: false };

  try {
    const args = ["--line-number", "--no-heading", "--color=never", "-e", pattern];
    if (glob) args.push("--glob", glob);
    args.push(searchPath);
    for (const d of ["!.git", "!node_modules", "!dist", "!target", "!.svn"]) args.push("--glob", d);
    args.push("-m", String(maxResults));

    let result: string;
    try {
      const cmd = new Deno.Command("rg", { args, stdout: "piped", stderr: "piped" });
      const { code, stdout } = await cmd.output();
      if (code === 0 || code === 1) { result = new TextDecoder().decode(stdout); }
      else throw new Error("rg failed");
    } catch {
      // Fallback to grep — translate glob to --include patterns
      const grepArgs = ["-rn", "-e", pattern];
      if (glob) {
        const patterns = glob.split(",").map((g) => g.trim());
        for (const p of patterns) {
          grepArgs.push("--include=" + p);
        }
      }
      grepArgs.push(searchPath);
      const cmd = new Deno.Command("grep", { args: grepArgs, stdout: "piped", stderr: "piped" });
      const { stdout } = await cmd.output();
      result = new TextDecoder().decode(stdout);
    }

    if (!result || !result.trim()) return { output: `No results found for pattern: ${pattern}`, error: false };
    const lines = result.trim().split("\n");
    if (lines.length >= maxResults) {
      return { output: lines.slice(0, maxResults).join("\n") + `\n... (${lines.length - maxResults} more results not shown)`, error: false };
    }
    return { output: result.trim(), error: false };
  } catch (e) {
    return { output: `Error searching files: ${(e as Error).message}`, error: true };
  }
}

async function execListDirectory(path: string | undefined, depth: number, opts: ToolExecOptions): Promise<ToolExecResult> {
  const dirPath = path ?? opts.cwd;
  const safety = isPathSafe(dirPath, opts.cwd, opts.sandbox);
  if (!safety.safe) return { output: `Error: ${safety.reason}`, error: true };
  const d = Math.max(1, Math.min(depth, 5));
  if (opts.dryRun) return { output: `[dry-run] Would list directory: ${dirPath} (depth: ${d})`, error: false };

  try {
    const lines: string[] = [];
    await listDirRecursive(dirPath, d, 0, lines, opts.cwd);
    return { output: lines.join("\n") || "(empty directory)", error: false };
  } catch (e) {
    return { output: `Error listing directory: ${(e as Error).message}`, error: true };
  }
}

async function listDirRecursive(dirPath: string, maxDepth: number, currentDepth: number, lines: string[], cwd: string): Promise<void> {
  if (currentDepth >= maxDepth) return;
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dirPath)) entries.push(entry);
  } catch {
    lines.push(`${"  ".repeat(currentDepth)}  ⚠ permission denied`);
    return;
  }
  entries.sort((a, b) => a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name));

  const indent = "  ".repeat(currentDepth);
  const prefix = currentDepth === 0 ? (dirPath === cwd ? "./" : dirPath + "/") : "";
  if (currentDepth === 0) lines.push(`${prefix}`);

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".ca.json") continue;
    const icon = entry.isDirectory ? "📁" : "📄";
    const sizeStr = entry.isFile ? await formatSize(`${dirPath}/${entry.name}`) : "";
    lines.push(`${indent}  ${icon} ${entry.name}${sizeStr ? " " + dim(sizeStr) : ""}`);
    if (entry.isDirectory && currentDepth + 1 < maxDepth) {
      await listDirRecursive(`${dirPath}/${entry.name}`, maxDepth, currentDepth + 1, lines, cwd);
    }
  }
}

async function formatSize(filePath: string): Promise<string> {
  try {
    const info = await Deno.stat(filePath);
    const bytes = info.size;
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  } catch { return ""; }
}

async function execAskUser(question: string, opts: ToolExecOptions): Promise<ToolExecResult> {
  const err = requireString(question, "question");
  if (err) return { output: err, error: true };
  if (opts.dryRun) return { output: `[dry-run] Would ask: ${question}`, error: false };
  if (!opts.askUser) return { output: `User interaction not available. Agent wants to ask: "${question}". In interactive mode you would be prompted.`, error: false };
  const answer = await opts.askUser(question);
  return { output: answer, error: false };
}

async function execApplyDiff(path: string, search: string, replace: string, opts: ToolExecOptions): Promise<ToolExecResult> {
  const pathErr = requireString(path, "path");
  if (pathErr) return { output: pathErr, error: true };
  const searchErr = requireString(search, "search");
  if (searchErr) return { output: searchErr, error: true };
  const safety = isPathSafe(path, opts.cwd, opts.sandbox);
  if (!safety.safe) return { output: `Error: ${safety.reason}`, error: true };
  if (opts.dryRun) return { output: `[dry-run] Would apply diff to ${path}: replace ${search.length} chars with ${replace.length} chars`, error: false };

  try {
    const original = await Deno.readTextFile(path);
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const count = (original.match(new RegExp(escaped, "g")) || []).length;

    if (count === 0) return { output: `Error: Could not find the search block in ${path}. Match exact whitespace.`, error: true };
    if (count > 1) return { output: `Error: Search block found ${count} times in ${path}. Must match exactly once. Make the search more specific.`, error: true };

    const updated = original.split(search).join(replace);

    if (opts.approve) {
      const { promptYesNo } = await import("./ca_ui.ts");
      const sp = search.length > 120 ? search.substring(0, 120) + "..." : search;
      const rp = replace.length > 120 ? replace.substring(0, 120) + "..." : replace;
      console.error(`\n${colorize("📝", C.yellow)} ${bold("apply_diff")} to ${colorize(path, C.white)}`);
      console.error(dim(`   - ${sp}`));
      console.error(dim(`   + ${rp}`));
      if (!await promptYesNo("Apply this change?")) return { output: `User declined diff to ${path}`, error: false };
    }

    // Git auto-snapshot
    if (opts.autoCommit) {
      const hash = await gitSnapshot(path, opts.cwd);
      if (hash) console.error(`  ${colorize("📸", C.dim)} ${dim(`git snapshot: ${hash}`)}`);
    }

    await Deno.writeTextFile(path, updated);

    // Show colored diff
    const diff = await computeDiff(path, original, updated, opts.cwd);
    if (diff) console.error(diff);

    return { output: `Successfully applied diff to ${path}: replaced ${search.length} bytes with ${replace.length} bytes`, error: false, diff: diff || undefined };
  } catch (e) {
    return { output: `Error applying diff: ${(e as Error).message}`, error: true };
  }
}

// ─── TypeScript Check ──────────────────────────────────

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

async function checkTypeScript(filePath: string, cwd: string): Promise<string | null> {
  const ext = filePath.substring(filePath.lastIndexOf("."));
  if (!TS_EXTENSIONS.has(ext)) return null;
  try {
    const cmd = new Deno.Command("deno", {
      args: ["check", filePath],
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);
    const combined = (out + (err ? "\n" + err : "")).trim();
    if (code === 0) {
      return "  ✔ deno check passed";
    } else {
      // Limit output size
      const truncated = combined.length > 1500
        ? combined.substring(0, 1500) + "\n...[truncated]"
        : combined;
      return `  ✘ deno check failed:\n${truncated}`;
    }
  } catch (e) {
    return `  ⚠ deno check unavailable: ${(e as Error).message}`;
  }
}

// ─── Git Auto-Snapshot ─────────────────────────────────

async function gitSnapshot(filePath: string, cwd: string): Promise<string | null> {
  try {
    const revParse = new Deno.Command("git", { args: ["rev-parse", "--show-toplevel"], cwd, stdout: "piped", stderr: "piped" });
    const { code: revCode } = await revParse.output();
    if (revCode !== 0) return null;

    const add = new Deno.Command("git", { args: ["add", filePath], cwd, stdout: "piped", stderr: "piped" });
    const { code: addCode } = await add.output();
    if (addCode !== 0) return null;

    const msg = `snapshot: auto-commit ${filePath} before CA modification`;
    const commit = new Deno.Command("git", { args: ["commit", "-m", msg, "--no-verify"], cwd, stdout: "piped", stderr: "piped" });
    const { code: commitCode, stdout: commitOut } = await commit.output();
    if (commitCode === 0) {
      const text = new TextDecoder().decode(commitOut).trim();
      const match = text.match(/\[.*?([a-f0-9]{7}).*?\]/);
      return match ? match[1] : null;
    }
    return null;
  } catch { return null; }
}

// ─── Colored Diff Display ──────────────────────────────

async function computeDiff(filePath: string, oldContent: string | null, newContent: string, cwd: string): Promise<string> {
  if (oldContent === null) {
    // New file — show all lines as additions
    const lines = newContent.split("\n").slice(0, 20);
    const preview = lines.map((l) => `${C.green}+ ${l}${C.reset}`).join("\n");
    const suffix = newContent.split("\n").length > 20 ? `\n${C.dim}  ... (+${newContent.split("\n").length - 20} more lines)${C.reset}` : "";
    return `\n${C.dim}  --- new file: ${filePath}${C.reset}\n${preview}${suffix}`;
  }

  // Try git diff
  try {
    const tmpDir = Deno.env.get("TMPDIR") ?? "/tmp";
    const oldFile = `${tmpDir}/.ca_diff_old_${Date.now()}`;
    const newFile = `${tmpDir}/.ca_diff_new_${Date.now()}`;
    await Deno.writeTextFile(oldFile, oldContent);
    await Deno.writeTextFile(newFile, newContent);

    const diff = new Deno.Command("git", {
      args: ["diff", "--no-index", "--color=always", "--unified=3", oldFile, newFile],
      stdout: "piped", stderr: "piped",
    });
    const { stdout } = await diff.output();
    const diffText = new TextDecoder().decode(stdout);

    try { await Deno.remove(oldFile); } catch { /* ok */ }
    try { await Deno.remove(newFile); } catch { /* ok */ }

    if (diffText.trim()) {
      const lines = diffText.split("\n");
      // Keep only hunk headers and changed/context lines, strip file headers
      const filtered = lines.filter((l) =>
        l.startsWith("@@") || l.startsWith("+") || l.startsWith("-") || l.startsWith(" ")
      );
      // Limit to 30 lines
      if (filtered.length > 30) {
        return `\n${filtered.slice(0, 30).join("\n")}\n${dim(`  ... (${filtered.length - 30} more lines)`)}`;
      }
      return `\n${filtered.join("\n")}`;
    }
  } catch { /* fall through */ }

  // Fallback: simple diff
  return simpleDiff(oldContent, newContent);
}

function simpleDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oldIdx = 0, newIdx = 0;
  let shown = 0;
  const MAX_SHOWN = 30;

  while ((oldIdx < oldLines.length || newIdx < newLines.length) && shown < MAX_SHOWN) {
    const oldLine = oldIdx < oldLines.length ? oldLines[oldIdx] : null;
    const newLine = newIdx < newLines.length ? newLines[newIdx] : null;

    if (oldLine === newLine) {
      if (shown < 6 || (oldIdx > oldLines.length - 6 && newIdx > newLines.length - 6)) {
        result.push(`  ${oldLine}`);
        shown++;
      } else if (result.length > 0 && result[result.length - 1] !== "...") {
        result.push(dim("  ..."));
        shown++;
      }
      oldIdx++; newIdx++;
    } else {
      let syncFound = false;
      for (let ahead = 1; ahead < 5 && (oldIdx + ahead < oldLines.length || newIdx + ahead < newLines.length); ahead++) {
        if (oldIdx + ahead < oldLines.length && newIdx < newLines.length && oldLines[oldIdx + ahead] === newLines[newIdx]) {
          for (let k = 0; k < ahead && shown < MAX_SHOWN; k++, shown++) {
            result.push(`${C.red}- ${oldLines[oldIdx + k]}${C.reset}`);
          }
          oldIdx += ahead;
          syncFound = true;
          break;
        }
        if (newIdx + ahead < newLines.length && oldIdx < oldLines.length && newLines[newIdx + ahead] === oldLines[oldIdx]) {
          for (let k = 0; k < ahead && shown < MAX_SHOWN; k++, shown++) {
            result.push(`${C.green}+ ${newLines[newIdx + k]}${C.reset}`);
          }
          newIdx += ahead;
          syncFound = true;
          break;
        }
      }
      if (!syncFound) {
        if (oldLine !== null) { result.push(`${C.red}- ${oldLine}${C.reset}`); shown++; }
        if (newLine !== null) { result.push(`${C.green}+ ${newLine}${C.reset}`); shown++; }
        oldIdx++; newIdx++;
      }
    }
  }

  const remaining = (oldLines.length - oldIdx) + (newLines.length - newIdx);
  if (remaining > 0) result.push(dim(`  ... (${remaining} more changes)`));
  return `\n${result.join("\n")}`;
}

// ─── Restart Self ──────────────────────────────────────

async function execRestartSelf(confirm: boolean, opts: ToolExecOptions): Promise<ToolExecResult> {
  if (!confirm) return { output: "Error: 'confirm' must be true to restart. Safety guard.", error: true };
  if (opts.dryRun) return { output: "[dry-run] Would verify and restart CA", error: false };

  const cwd = opts.cwd;

  console.error(`\n${colorize("🔄", C.cyan)} ${bold("Self-upgrade check...")}`);

  // Run type check
  console.error(dim("  deno check ca.ts..."));
  const check = new Deno.Command("deno", { args: ["check", "ca.ts"], cwd, stdout: "piped", stderr: "piped" });
  const { code: checkCode, stderr: checkErr } = await check.output();
  if (checkCode !== 0) {
    const errText = new TextDecoder().decode(checkErr);
    console.error(`  ${colorize("✘", C.red)} ${bold("Type check failed")}`);
    console.error(dim(errText.substring(0, 500)));
    return { output: `Error: Type checking failed:\n${errText.substring(0, 500)}`, error: true };
  }
  console.error(`  ${colorize("✔", C.green)} ${dim("Type check passed")}`);

  // Run tests
  console.error(dim("  deno test -A ca_test.ts..."));
  const test = new Deno.Command("deno", { args: ["test", "-A", "ca_test.ts"], cwd, stdout: "piped", stderr: "piped" });
  const { code: testCode, stderr: testErr } = await test.output();
  if (testCode !== 0) {
    const errText = new TextDecoder().decode(testErr);
    console.error(`  ${colorize("✘", C.red)} ${bold("Tests failed")}`);
    console.error(dim(errText.substring(0, 500)));
    return { output: `Error: Tests failed:\n${errText.substring(0, 500)}`, error: true };
  }
  console.error(`  ${colorize("✔", C.green)} ${dim("Tests passed")}`);

  // Signal the agent loop to perform the actual restart
  return { output: "RESTART_READY", error: false };
}
