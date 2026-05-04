import type { ToolDef, AgentConfig, ToolExecResult } from "./ca_types.ts";
import { colorize, dim, bold } from "./ca_ui.ts";
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
          "Write content to a file. Creates it if it doesn't exist, overwrites if it does. Parent directories are created automatically.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to write the file to" },
            content: {
              type: "string",
              description: "Content to write to the file",
            },
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
        description:
          "Execute a bash shell command. Returns combined stdout+stderr with exit code. Commands timeout after 120s.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" },
            workdir: {
              type: "string",
              description: "Optional working directory. Defaults to current directory.",
            },
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
        description:
          "Search for a pattern in files. Uses ripgrep if available, falls back to grep. Returns matching lines with file paths and line numbers. Supports full regex syntax (e.g. 'function\\s+foo', 'TODO|FIXME', 'import.*from').",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Regex pattern to search for (e.g. 'function', 'TODO', 'import.*from')",
            },
            path: {
              type: "string",
              description: "Directory or file to search in. Defaults to current directory.",
            },
            glob: {
              type: "string",
              description: "File glob pattern to filter (e.g. '*.ts', '*.{js,ts}'). Defaults to all text files.",
            },
            maxResults: {
              type: "number",
              description: "Maximum number of results to return. Defaults to 50.",
            },
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
        description:
          "List the contents of a directory. Shows files and subdirectories with their sizes. Supports recursive listing up to a specified depth.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Directory path. Defaults to current directory.",
            },
            depth: {
              type: "number",
              description: "Recursion depth. 1 = current dir only, 2 = one level deep, etc. Defaults to 1.",
            },
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
        description:
          "Ask the user a clarifying question. Use this when you need to make an important decision with multiple reasonable options, or when you need additional context to proceed effectively.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question to ask the user. Be specific and concise.",
            },
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
        description:
          "Apply a targeted change to a file using a search-and-replace pattern. Finds the SEARCH block in the file and replaces it with the REPLACE block. The SEARCH block must match exactly once. This is preferred over write_file for small, targeted edits to large files.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to modify",
            },
            search: {
              type: "string",
              description: "Exact text to find in the file. Must match exactly once, including whitespace.",
            },
            replace: {
              type: "string",
              description: "Text to replace the search block with.",
            },
          },
          required: ["path", "search", "replace"],
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
  cwd: string;
  askUser?: AskUserCallback;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  opts: ToolExecOptions,
): Promise<ToolExecResult> {
  switch (name) {
    case "read_file":
      return execReadFile(args.path as string, opts);
    case "write_file":
      return execWriteFile(args.path as string, args.content as string, opts);
    case "run_command":
      return execRunCommand(args.command as string, args.workdir as string | undefined, opts);
    case "search_files":
      return execSearchFiles(
        args.pattern as string,
        args.path as string | undefined,
        args.glob as string | undefined,
        (args.maxResults as number) ?? 50,
        opts,
      );
    case "list_directory":
      return execListDirectory(
        args.path as string | undefined,
        (args.depth as number) ?? 1,
        opts,
      );
    case "ask_user":
      return execAskUser(args.question as string, opts);
    case "apply_diff":
      return execApplyDiff(
        args.path as string,
        args.search as string,
        args.replace as string,
        opts,
      );
    default:
      return { output: `Unknown tool: ${name}`, error: true };
  }
}

// ─── Individual Executors ──────────────────────────────

async function execReadFile(path: string, opts: ToolExecOptions): Promise<ToolExecResult> {
  if (!path || typeof path !== "string") {
    return { output: "Error: path is required", error: true };
  }

  const safety = isPathSafe(path, opts.cwd, opts.sandbox);
  if (!safety.safe) {
    return { output: `Error: ${safety.reason}`, error: true };
  }

  if (opts.dryRun) {
    return { output: `[dry-run] Would read file: ${path}`, error: false };
  }

  try {
    const content = await Deno.readTextFile(path);
    // Add line numbers for reference
    const lines = content.split("\n");
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(4, " ")}| ${line}`);
    return { output: numbered.join("\n"), error: false };
  } catch (e) {
    return { output: `Error reading file: ${(e as Error).message}`, error: true };
  }
}

async function execWriteFile(
  path: string,
  content: string,
  opts: ToolExecOptions,
): Promise<ToolExecResult> {
  if (!path || typeof path !== "string") {
    return { output: "Error: path is required", error: true };
  }
  if (content === undefined || content === null) {
    return { output: "Error: content is required", error: true };
  }

  const safety = isPathSafe(path, opts.cwd, opts.sandbox);
  if (!safety.safe) {
    return { output: `Error: ${safety.reason}`, error: true };
  }

  // In approve mode, prompt user
  if (opts.approve) {
    const preview = content.length > 200 ? content.substring(0, 200) + "..." : content;
    console.error(`\n${colorize("✏️", dim(""))} ${bold("write_file")} to ${colorize(path, dim(""))}`);
    console.error(dim(`   Preview: ${preview}`));
    const { promptYesNo } = await import("./ca_ui.ts");
    const ok = await promptYesNo(`Write ${content.length} bytes to ${path}?`);
    if (!ok) {
      return { output: `User declined write to ${path}`, error: false };
    }
  }

  if (opts.dryRun) {
    return {
      output: `[dry-run] Would write ${content.length} bytes to: ${path}`,
      error: false,
    };
  }

  try {
    // Track if this is an overwrite
    let existed = false;
    try {
      await Deno.stat(path);
      existed = true;
    } catch { /* doesn't exist */ }

    const lastSep = path.lastIndexOf("/");
    if (lastSep > 0) {
      await Deno.mkdir(path.substring(0, lastSep), { recursive: true });
    }
    await Deno.writeTextFile(path, content);
    return {
      output: existed
        ? `Successfully overwrote ${path} with ${content.length} bytes`
        : `Successfully created ${path} with ${content.length} bytes`,
      error: false,
    };
  } catch (e) {
    return { output: `Error writing file: ${(e as Error).message}`, error: true };
  }
}

async function execRunCommand(
  command: string,
  workdir: string | undefined,
  opts: ToolExecOptions,
): Promise<ToolExecResult> {
  if (!command || typeof command !== "string") {
    return { output: "Error: command is required", error: true };
  }

  // Check command safety
  const safety = isCommandSafe(command);
  if (!safety.safe) {
    if (opts.approve) {
      const { promptYesNo } = await import("./ca_ui.ts");
      console.error(`\n${colorize("⚠", dim(""))} ${bold("Potentially dangerous command:")} ${dim(safety.reason ?? "Unknown")}`);
      console.error(`   ${dim(command)}`);
      const ok = await promptYesNo("Execute anyway?");
      if (!ok) {
        return { output: `User declined to run: ${command}`, error: false };
      }
    } else {
      return {
        output: `Error: Command blocked: ${safety.reason}. Use --approve to override.`,
        error: true,
      };
    }
  }

  // Validate workdir
  const cwd = workdir ?? opts.cwd;
  if (workdir) {
    const dirSafety = isPathSafe(workdir, opts.cwd, opts.sandbox);
    if (!dirSafety.safe) {
      return { output: `Error: Working directory: ${dirSafety.reason}`, error: true };
    }
  }

  if (opts.dryRun) {
    return { output: `[dry-run] Would run: ${command} (in ${cwd})`, error: false };
  }

  try {
    const cmd = new Deno.Command("bash", {
      args: ["-c", command],
      cwd,
      stdout: "piped",
      stderr: "piped",
      env: Deno.env.toObject(),
    });

    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);

    let result = "";
    if (out) result += out;
    if (err) result += (result ? "\n" : "") + err;
    result += `\n[exit: ${code}]`;

    if (result.length > 10000) {
      result = result.substring(0, 10000) + "\n...[truncated]";
    }
    return { output: result, error: code !== 0 };
  } catch (e) {
    return { output: `Error running command: ${(e as Error).message}`, error: true };
  }
}

async function execSearchFiles(
  pattern: string,
  path: string | undefined,
  glob: string | undefined,
  maxResults: number,
  opts: ToolExecOptions,
): Promise<ToolExecResult> {
  if (!pattern || typeof pattern !== "string") {
    return { output: "Error: pattern is required", error: true };
  }

  const searchPath = path ?? opts.cwd;
  const safety = isPathSafe(searchPath, opts.cwd, opts.sandbox);
  if (!safety.safe) {
    return { output: `Error: ${safety.reason}`, error: true };
  }

  if (opts.dryRun) {
    return {
      output: `[dry-run] Would search for "${pattern}" in ${searchPath}`,
      error: false,
    };
  }

  try {
    // Try ripgrep first, fall back to grep
    const args = ["rg", "--line-number", "--no-heading", "--color=never", "-e", pattern];

    if (glob) {
      args.push("--glob", glob);
    }
    args.push(searchPath);

    // Exclude common dirs
    args.push("--glob", "!.git");
    args.push("--glob", "!node_modules");
    args.push("--glob", "!dist");
    args.push("--glob", "!target");
    args.push("--glob", "!.svn");

    // Limit results
    args.push("-m", String(maxResults));

    let result: string;
    try {
      const cmd = new Deno.Command("rg", {
        args,
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stdout, stderr } = await cmd.output();
      if (code === 0 || code === 1) {
        // rg returns 1 when no matches found
        result = new TextDecoder().decode(stdout);
      } else {
        throw new Error("rg failed");
      }
    } catch {
      // Fall back to grep
      const grepArgs = ["-rn", "--include=" + (glob ? glob.replace(/[{}]/g, "") : "*"), "-e", pattern, searchPath];
      try {
        const cmd = new Deno.Command("grep", {
          args: grepArgs,
          stdout: "piped",
          stderr: "piped",
        });
        const { stdout } = await cmd.output();
        result = new TextDecoder().decode(stdout);
      } catch {
        return { output: `Error: Neither ripgrep nor grep available for search`, error: true };
      }
    }

    if (!result || !result.trim()) {
      return { output: `No results found for pattern: ${pattern}`, error: false };
    }

    const lines = result.trim().split("\n");
    if (lines.length >= maxResults) {
      return {
        output: lines.slice(0, maxResults).join("\n") +
          `\n... (${lines.length - maxResults} more results not shown)`,
        error: false,
      };
    }
    return { output: result.trim(), error: false };
  } catch (e) {
    return { output: `Error searching files: ${(e as Error).message}`, error: true };
  }
}

async function execListDirectory(
  path: string | undefined,
  depth: number,
  opts: ToolExecOptions,
): Promise<ToolExecResult> {
  const dirPath = path ?? opts.cwd;
  const safety = isPathSafe(dirPath, opts.cwd, opts.sandbox);
  if (!safety.safe) {
    return { output: `Error: ${safety.reason}`, error: true };
  }

  // Clamp depth
  const d = Math.max(1, Math.min(depth, 5));

  if (opts.dryRun) {
    return {
      output: `[dry-run] Would list directory: ${dirPath} (depth: ${d})`,
      error: false,
    };
  }

  try {
    const lines: string[] = [];
    await listDirRecursive(dirPath, d, 0, lines, opts.cwd);
    return { output: lines.join("\n") || "(empty directory)", error: false };
  } catch (e) {
    return { output: `Error listing directory: ${(e as Error).message}`, error: true };
  }
}

async function listDirRecursive(
  dirPath: string,
  maxDepth: number,
  currentDepth: number,
  lines: string[],
  cwd: string,
): Promise<void> {
  if (currentDepth >= maxDepth) return;

  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(dirPath)) {
    entries.push(entry);
  }
  entries.sort((a, b) => {
    // Directories first, then alphabetical
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const indent = "  ".repeat(currentDepth);
  const prefix = currentDepth === 0
    ? (dirPath === cwd ? "./" : dirPath + "/")
    : "";

  if (currentDepth === 0) {
    lines.push(`${prefix}`);
  }

  for (const entry of entries) {
    // Skip hidden files/dirs and common noise
    if (entry.name.startsWith(".") && entry.name !== ".ca.json") continue;

    const icon = entry.isDirectory ? "📁" : "📄";
    const sizeStr = entry.isFile ? formatSize(`${dirPath}/${entry.name}`) : "";
    const line = `${indent}  ${icon} ${entry.name}${sizeStr ? " " + dim(sizeStr) : ""}`;
    lines.push(line);

    if (entry.isDirectory && currentDepth + 1 < maxDepth) {
      await listDirRecursive(
        `${dirPath}/${entry.name}`,
        maxDepth,
        currentDepth + 1,
        lines,
        cwd,
      );
    }
  }
}

function formatSize(filePath: string): string {
  try {
    const info = Deno.statSync(filePath);
    const bytes = info.size;
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  } catch {
    return "";
  }
}

async function execAskUser(
  question: string,
  opts: ToolExecOptions,
): Promise<ToolExecResult> {
  if (!question || typeof question !== "string") {
    return { output: "Error: question is required", error: true };
  }

  if (opts.dryRun) {
    return { output: `[dry-run] Would ask: ${question}`, error: false };
  }

  if (!opts.askUser) {
    return {
      output: `User interaction not available. The agent wants to ask: "${question}". In interactive mode you would be prompted for input.`,
      error: false,
    };
  }

  const answer = await opts.askUser(question);
  return { output: answer, error: false };
}

async function execApplyDiff(
  path: string,
  search: string,
  replace: string,
  opts: ToolExecOptions,
): Promise<ToolExecResult> {
  if (!path || typeof path !== "string") {
    return { output: "Error: path is required", error: true };
  }
  if (!search) {
    return { output: "Error: search block is required", error: true };
  }

  const safety = isPathSafe(path, opts.cwd, opts.sandbox);
  if (!safety.safe) {
    return { output: `Error: ${safety.reason}`, error: true };
  }

  if (opts.dryRun) {
    return {
      output: `[dry-run] Would apply diff to ${path}: replace ${search.length} chars with ${replace.length} chars`,
      error: false,
    };
  }

  try {
    const original = await Deno.readTextFile(path);
    const count = (original.match(new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;

    if (count === 0) {
      return {
        output: `Error: Could not find the search block in ${path}. The text must match exactly, including whitespace.`,
        error: true,
      };
    }
    if (count > 1) {
      return {
        output: `Error: Search block found ${count} times in ${path}. It must match exactly once. Please make the search more specific.`,
        error: true,
      };
    }

    const updated = original.split(search).join(replace);

    if (opts.approve) {
      const { promptYesNo } = await import("./ca_ui.ts");
      // Show a simple diff
      const searchPreview = search.length > 120 ? search.substring(0, 120) + "..." : search;
      const replacePreview = replace.length > 120 ? replace.substring(0, 120) + "..." : replace;
      console.error(`\n${colorize("📝", dim(""))} ${bold("apply_diff")} to ${colorize(path, dim(""))}`);
      console.error(dim(`   - ${searchPreview}`));
      console.error(dim(`   + ${replacePreview}`));
      const ok = await promptYesNo("Apply this change?");
      if (!ok) {
        return { output: `User declined diff to ${path}`, error: false };
      }
    }

    await Deno.writeTextFile(path, updated);
    return {
      output: `Successfully applied diff to ${path}: replaced ${search.length} bytes with ${replace.length} bytes`,
      error: false,
    };
  } catch (e) {
    return { output: `Error applying diff: ${(e as Error).message}`, error: true };
  }
}
