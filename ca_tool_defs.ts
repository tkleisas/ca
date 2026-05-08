import type { AgentConfig, ToolDef } from "./ca_types.ts";


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

  if (config.tools.spawn_subagent) {
    defs.push({
      type: "function",
      function: {
        name: "spawn_subagent",
        description: `Spawn an isolated subagent to complete a delegated task. Returns the task result.

The subagent runs in a separate process with its own context window. It has access to a restricted set of tools. Use this for:
- Exploration/research tasks (search codebase, find patterns)
- Long-running verification work (run tests, check types)
- Tasks that would pollute the main conversation context

For quick tasks use parallel: false (blocking). For longer tasks, use parallel: true to get an ID immediately, then poll with check_subagent or wait with await_subagent.`,
        parameters: {
          type: "object",
          properties: {
            task: { type: "string", description: "The task for the subagent to complete. Be specific about what to find, search for, or report on. Include instructions for the expected output format." },
            tools: {
              type: "array",
              items: { type: "string", enum: ["read_file", "write_file", "run_command", "search_files", "list_directory", "apply_diff"] },
              description: "Tools to grant the subagent. Defaults to read-only: read_file, search_files, list_directory. Use write_file and run_command only when the subagent needs to make changes.",
            },
            max_tokens: { type: "number", description: "Max token budget for the subagent. Defaults to 50000." },
            max_rounds: { type: "number", description: "Max rounds for the subagent. Defaults to 20." },
            parallel: { type: "boolean", description: "If true, starts the subagent in the background and returns immediately with an ID. Use check_subagent to poll, or await_subagent to block until done. Defaults to false (blocking)." },
          },
          required: ["task"],
        },
      },
    });
  }

  if (config.tools.check_subagent) {
    defs.push({
      type: "function",
      function: {
        name: "check_subagent",
        description: "Check the status of a parallel subagent without blocking. Returns the current status and elapsed time. If the subagent has finished, the result is included.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "The subagent ID returned by spawn_subagent." },
          },
          required: ["id"],
        },
      },
    });
  }

  if (config.tools.await_subagent) {
    defs.push({
      type: "function",
      function: {
        name: "await_subagent",
        description: "Block until a parallel subagent completes and return its result. Use when you need the subagent's output before continuing.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "The subagent ID returned by spawn_subagent." },
          },
          required: ["id"],
        },
      },
    });
  }

  if (config.tools.test_web) {
    defs.push({
      type: "function",
      function: {
        name: "test_web",
        description: "Test the CA web UI by starting it on a given port, running WebSocket API tests (fast, zero deps), and optionally Playwright browser tests. Returns test results. Use to verify the web interface works correctly.",
        parameters: {
          type: "object",
          properties: {
            port: { type: "number", description: "Port to run the web server on (default: 9420)" },
            playwright: { type: "boolean", description: "Also run full Playwright browser tests (default: false). Requires: npx playwright install chromium" },
            quick: { type: "boolean", description: "Quick mode: skip slow browser tests (default: false)" },
          },
          required: [],
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

