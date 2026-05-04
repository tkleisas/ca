import type { ChatMessage, ConversationExport } from "./ca_types.ts";
import type { AgentConfig } from "./ca_types.ts";
import { buildToolDefs, executeTool, type AskUserCallback } from "./ca_tools.ts";
import { chatCompletion } from "./ca_client.ts";
import { C, Spinner, formatToolCall, formatToolResult, colorize, dim, bold } from "./ca_ui.ts";
import { estimateMessagesTokens } from "./ca_client.ts";
import { sandboxContext } from "./ca_sandbox.ts";

const VERSION = "0.1.0";

// ─── System Prompt ─────────────────────────────────────

export function buildSystemPrompt(config: AgentConfig): string {
  if (config.systemPrompt) return config.systemPrompt;

  const toolList = [
    config.tools.read_file ? "- read_file(path): Read a file's contents" : null,
    config.tools.write_file ? "- write_file(path, content): Create or overwrite a file" : null,
    config.tools.run_command ? "- run_command(command, workdir?): Execute a bash shell command" : null,
    config.tools.search_files ? "- search_files(pattern, path?, glob?): Search for a regex pattern in files" : null,
    config.tools.list_directory ? "- list_directory(path?, depth?): List directory contents" : null,
    config.tools.ask_user ? "- ask_user(question): Ask the user a clarifying question" : null,
    config.tools.apply_diff ? "- apply_diff(path, search, replace): Apply a targeted edit to a file" : null,
    config.tools.restart_self ? "- restart_self(confirm): Restart CA with an improved version of itself" : null,
  ].filter(Boolean).join("\n");

  let prompt =
    `You are CA ${VERSION}, a coding agent that helps with software engineering tasks.

You have access to these tools:
${toolList}

Your own source code lives in ca.ts (and ca_*.ts modules) in the current working directory. You can read and modify them to improve your own design. This is fundamental to your purpose: you are a self-evolving agent.

Guidelines:
- Be thorough: read existing code before modifying it
- Verify your work: use run_command to run tests, linters, or compile
- Follow conventions of the codebase you're working in
- Prefer editing existing files over creating new ones
- If unsure, read relevant files first
- Write clean, idiomatic code
- Use search_files to find patterns, references, and definitions
- Use list_directory to understand project structure
- Use ask_user when you need clarification on ambiguous requests
- Use apply_diff for small targeted edits instead of rewriting entire files`;

  if (config.approve) {
    prompt += `\n\nApproval mode is active. You must get user confirmation before write_file, run_command (dangerous), and apply_diff operations.`;
  }

  if (config.dryRun) {
    prompt += `\n\nDry-run mode is active. All tools will report what they *would* do without actually modifying anything.`;
  }

  prompt += sandboxContext(Deno.cwd(), config.sandbox);

  return prompt;
}

// ─── Project Context ───────────────────────────────────

export async function getProjectContext(cwd: string): Promise<string> {
  const parts: string[] = [];
  parts.push(`Working directory: ${cwd}`);

  // Git info
  try {
    const gitBranch = new Deno.Command("git", {
      args: ["branch", "--show-current"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout: branchOut } = await gitBranch.output();
    const branch = new TextDecoder().decode(branchOut).trim();
    if (branch) parts.push(`Git branch: ${branch}`);

    const gitStatus = new Deno.Command("git", {
      args: ["status", "--short"],
      cwd,
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout: statusOut } = await gitStatus.output();
    const status = new TextDecoder().decode(statusOut).trim();
    if (status) {
      const changedFiles = status.split("\n").slice(0, 15);
      parts.push(`Changed files:\n${changedFiles.join("\n")}`);
    }
  } catch { /* not a git repo */ }

  // Directory overview
  try {
    const entries: string[] = [];
    for await (const entry of Deno.readDir(cwd)) {
      if (entry.name.startsWith(".")) continue;
      const icon = entry.isDirectory ? "/" : "";
      entries.push(`  ${entry.name}${icon}`);
    }
    if (entries.length > 0 && entries.length <= 30) {
      parts.push(`Top-level directory:\n${entries.sort().join("\n")}`);
    }
  } catch { /* can't read dir */ }

  // Language detection
  try {
    const exts = new Map<string, number>();
    for await (const entry of Deno.readDir(cwd)) {
      if (entry.isFile) {
        const ext = entry.name.includes(".") ? entry.name.split(".").pop() ?? "" : "";
        if (ext && ext.length < 10) {
          exts.set(ext, (exts.get(ext) ?? 0) + 1);
        }
      }
    }
    if (exts.size > 0) {
      const sorted = [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      parts.push(`File types: ${sorted.map(([ext, count]) => `.${ext}(${count})`).join(", ")}`);
    }
  } catch { /* can't scan */ }

  return parts.join("\n");
}

// ─── Agent Loop ────────────────────────────────────────

export interface AgentOptions {
  config: AgentConfig;
  askUser?: AskUserCallback;
}

export async function run(
  prompt: string,
  messages?: ChatMessage[],
  opts?: AgentOptions,
): Promise<ChatMessage[]> {
  const config = opts?.config!;
  const askUser = opts?.askUser;
  const tools = buildToolDefs(config);
  const systemPrompt = buildSystemPrompt(config);

  // Gather project context
  let contextStr = "";
  try {
    contextStr = await getProjectContext(Deno.cwd());
  } catch { /* non-critical */ }

  const systemContent = contextStr
    ? systemPrompt + `\n\nProject context:\n${contextStr}`
    : systemPrompt;

  const msgs = messages ?? [
    { role: "system" as const, content: systemContent },
  ];

  // Update system prompt if messages already have one
  if (messages && messages.length > 0 && messages[0].role === "system") {
    messages[0].content = systemContent;
  }

  // Add the user message
  msgs.push({ role: "user", content: prompt });

  const spinner = new Spinner();
  let totalTokens = estimateMessagesTokens(msgs);

  for (let round = 1; round <= config.maxRounds; round++) {
    // Token budget check
    const estTokens = estimateMessagesTokens(msgs);
    if (estTokens > config.maxTokens * 0.85) {
      console.error(
        `${colorize("⚠", dim(""))} ${bold("Token budget warning:")} ~${estTokens} estimated tokens (${((estTokens / config.maxTokens) * 100).toFixed(0)}% of ${config.maxTokens})`,
      );
    }
    if (estTokens > config.maxTokens) {
      console.error(
        `${colorize("✘", dim(""))} ${bold("Token budget exceeded:")} ~${estTokens} > ${config.maxTokens} max`,
      );
      break;
    }

    spinner.start(`Round ${round}/${config.maxRounds} — ${config.model}`);

    let response: ChatMessage;
    let usage;
    try {
      const result = await chatCompletion(msgs, tools, config);
      response = result.message;
      usage = result.usage;
      if (usage) {
        totalTokens += usage.totalTokens;
      }
    } catch (e) {
      spinner.fail(`API error: ${(e as Error).message}`);
      throw e;
    }

    msgs.push(response);

    if (response.tool_calls?.length) {
      spinner.stop();

      // Execute tools in parallel
      const toolResults = await Promise.all(
        response.tool_calls.map(async (tc) => {
          const name = tc.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            console.error(
              `${colorize("⚠", dim(""))} Failed to parse arguments for ${name}`,
            );
            return {
              tc,
              result: `Error: Invalid JSON arguments: ${tc.function.arguments.substring(0, 200)}`,
            };
          }

          // Pretty print
          console.error(`\n${formatToolCall(name, args)}`);

          const result = await executeTool(name, args, {
            sandbox: config.sandbox,
            approve: config.approve,
            dryRun: config.dryRun,
            autoCommit: config.autoCommit,
            cwd: Deno.cwd(),
            askUser,
          });

          console.error(formatToolResult(result.output));

          return { tc, result: result.output };
        }),
      );

      // Check for errors and collect
      let hasErrors = false;
      for (const { tc, result } of toolResults) {
        msgs.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
        if (result.startsWith("Error") || result.startsWith("Error:")) {
          hasErrors = true;
        }
      }

      // Check for restart signal
      for (const { tc, result } of toolResults) {
        if (result === "RESTART_READY") {
          spinner.stop();
          console.error(`\n${colorize("🔄", C.cyan)} ${bold("Restarting with new version...")}`);
          const resumeFile = `${Deno.cwd()}/.ca_resume.json`;
          await saveConversation(msgs, resumeFile);
          console.error(dim("  Spawning new CA process..."));
          const child = new Deno.Command("deno", {
            args: ["run", "-A", "ca.ts", "--resume", resumeFile],
            cwd: Deno.cwd(),
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          }).spawn();
          Deno.exit(0);
        }
      }

      // If there were errors, add a hint for the model
      if (hasErrors) {
        console.error(
          `  ${colorize("⚠", dim(""))} Some tool calls returned errors — model will attempt recovery`,
        );
        // Errors are already in the tool messages, model can recover automatically
      }

      console.error(""); // blank line between rounds

      // If in dry-run mode, stop after one round
      if (config.dryRun) {
        spinner.succeed("Dry-run complete (1 round)");
        return msgs;
      }
    } else {
      // No tool calls — final response
      spinner.succeed(`Done (${round} round${round > 1 ? "s" : ""})`);
      if (response.content) {
        console.log(response.content);
      }
      return msgs;
    }
  }

  console.error(`${colorize("⚠", dim(""))} Reached max rounds (${config.maxRounds})`);
  return msgs;
}

// ─── Conversation Save/Load ────────────────────────────

export async function saveConversation(
  messages: ChatMessage[],
  filepath: string,
): Promise<void> {
  const exportData: ConversationExport = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    messages,
  };
  await Deno.writeTextFile(filepath, JSON.stringify(exportData, null, 2));
  console.error(
    `${colorize("✔", dim(""))} Saved ${messages.length} messages to ${dim(filepath)}`,
  );
}

export async function loadConversation(filepath: string): Promise<ChatMessage[]> {
  const raw = await Deno.readTextFile(filepath);
  const data: ConversationExport = JSON.parse(raw);
  if (!data.version || !Array.isArray(data.messages)) {
    throw new Error("Invalid conversation file format");
  }
  console.error(
    `${colorize("✔", dim(""))} Loaded ${data.messages.length} messages from ${dim(filepath)} (saved ${data.timestamp})`,
  );
  return data.messages;
}
