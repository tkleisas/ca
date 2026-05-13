import type { ChatMessage, ConversationExport, AgentConfig, SubagentInput, SubagentResult } from "./ca_types.ts";
import { VERSION } from "./ca_types.ts";
import { buildToolDefs, executeTool, type AskUserCallback } from "./ca_tools.ts";
import { chatCompletion, estimateMessagesTokens, type CompletionOpts } from "./ca_client.ts";
import { C, Spinner, formatToolCall, formatToolResult, colorize, dim, bold } from "./ca_ui.ts";
import { sandboxContext } from "./ca_sandbox.ts";
import { initDebugLog, getDebugLog, closeDebugLog, logRound, logMessagesSent, logResponse, logToolCall, logToolResult, logCompaction, logError, logSessionStart } from "./ca_log.ts";

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

export async function buildSystemContent(config: AgentConfig, cwd: string): Promise<string> {
  const systemPrompt = buildSystemPrompt(config);
  let contextStr = "";
  try {
    contextStr = await getProjectContext(cwd);
  } catch { /* non-critical */ }
  return contextStr
    ? systemPrompt + `\n\nProject context:\n${contextStr}`
    : systemPrompt;
}

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

// ─── Context Compaction ────────────────────────────────

/**
 * When context usage exceeds 90%, compact the conversation by summarizing
 * intermediate rounds while keeping the system prompt, initial user request,
 * and most recent rounds intact.
 *
 * Returns the compacted messages array and a boolean indicating if compaction happened.
 */
export function compactConversation(messages: ChatMessage[]): { messages: ChatMessage[]; compacted: boolean } {
  if (messages.length < 4) return { messages, compacted: false };

  // Identify system message
  const sysIdx = messages[0]?.role === "system" ? 0 : -1;
  // First user message after system
  const firstUserIdx = sysIdx >= 0
    ? messages.findIndex((m, i) => i > sysIdx && m.role === "user")
    : messages.findIndex((m) => m.role === "user");

  if (firstUserIdx < 0) return { messages, compacted: false };

  // Count "rounds" — each assistant message with tool_calls is a round
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant" && messages[i].tool_calls?.length) {
      assistantIndices.push(i);
    }
  }

  // Need at least 3 rounds to make compaction worthwhile
  if (assistantIndices.length < 3) return { messages, compacted: false };

  // Keep the last few rounds intact (40% of rounds, min 2, max 5)
  const keepRounds = Math.max(2, Math.min(5, Math.ceil(assistantIndices.length * 0.4)));
  const splitPoint = assistantIndices[assistantIndices.length - keepRounds];

  // Everything from firstUserIdx to splitPoint gets summarized
  const summarizedMessages = messages.slice(firstUserIdx, splitPoint);

  // Build summary
  const summaryParts: string[] = [];
  summaryParts.push("[Context compacted — earlier steps summarized]\n");

  // Track tool usage
  const toolCounts = new Map<string, number>();
  const filesSeen = new Set<string>();
  let totalAssistantMsgs = 0;
  let totalThinkingChars = 0;

  for (const msg of summarizedMessages) {
    if (msg.role === "assistant") {
      totalAssistantMsgs++;
      if (msg.reasoning_content) {
        totalThinkingChars += msg.reasoning_content.length;
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCounts.set(tc.function.name, (toolCounts.get(tc.function.name) ?? 0) + 1);
          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.path) filesSeen.add(args.path as string);
          } catch { /* ignore parse errors */ }
        }
      }
    }
    if (msg.role === "tool" && msg.content) {
      // Check for key findings in tool results
      const c = msg.content;
      if (c.startsWith("Error") && c.length < 200) {
        summaryParts.push(`- Encountered error: ${c.substring(0, 120)}`);
      }
    }
  }

  summaryParts.push(`\nRounds compacted: ${assistantIndices.length - keepRounds}`);
  summaryParts.push(`Tool calls made: ${[...toolCounts.entries()].map(([k, v]) => `${k}(${v})`).join(", ")}`);
  if (filesSeen.size > 0 && filesSeen.size <= 20) {
    summaryParts.push(`Files examined: ${[...filesSeen].join(", ")}`);
  }

  // Build the compacted messages array
  const compacted: ChatMessage[] = [];

  // 1. System message
  if (sysIdx >= 0) compacted.push(messages[sysIdx]);

  // 2. First user message
  compacted.push(messages[firstUserIdx]);

  // 3. Summary as an assistant message
  compacted.push({
    role: "assistant",
    content: summaryParts.join("\n"),
  });

  // 4. Everything from splitPoint onward
  for (let i = splitPoint; i < messages.length; i++) {
    compacted.push(messages[i]);
  }

  return { messages: compacted, compacted: true };
}

// ─── Agent Loop ────────────────────────────────────────

export interface AgentOptions {
  config: AgentConfig;
  askUser?: AskUserCallback;
  signal?: AbortSignal;
}

export interface RunResult {
  messages: ChatMessage[];
  needsRestart: boolean;
}

export async function run(
  prompt: string,
  messages?: ChatMessage[],
  opts?: AgentOptions,
): Promise<RunResult> {
  const config = opts?.config!;
  const askUser = opts?.askUser;
  const tools = buildToolDefs(config);
  const systemContent = await buildSystemContent(config, Deno.cwd());

  const msgs = messages ?? [
    { role: "system" as const, content: systemContent },
  ];

  // Update system prompt if messages already have one
  if (messages && messages.length > 0 && messages[0].role === "system") {
    messages[0].content = systemContent;
  }

  // Add the user message
  msgs.push({ role: "user", content: prompt });

  // ── Debug logging ──
  const cwd = Deno.cwd();
  const dbgLog = await initDebugLog(cwd);
  logSessionStart(dbgLog, config.model, config.apiBase, config.maxTokens, config.maxOutputTokens, cwd);

  const spinner = new Spinner();
  let totalApiTokens = 0; // actual tokens from API responses

  for (let round = 1; round <= config.maxRounds; round++) {
    // Check for abort signal
    if (opts?.signal?.aborted) {
      console.error(`\n${colorize("⚠", dim(""))} Aborted by signal.`);
      break;
    }

    // Token budget check (estimated context size) — show when significant
    let estTokens = estimateMessagesTokens(msgs);
    const tokenPct = ((estTokens / config.maxTokens) * 100).toFixed(1);
    if (round === 1 || estTokens > config.maxTokens * 0.3) {
      const color = estTokens > config.maxTokens * 0.7 ? C.yellow : C.dim;
      console.error(
        colorize(`  [context: ${estTokens.toLocaleString()} / ${config.maxTokens.toLocaleString()} (${tokenPct}%)]`, color),
      );
    }

    // ── Auto-compaction when > 90% context utilization ──
    if (estTokens > config.maxTokens * 0.9) {
      console.error(
        `${colorize("🔄", C.yellow)} ${bold("Context compaction triggered")} — ${tokenPct}% utilization (${estTokens.toLocaleString()} tokens)`,
      );
      const preCount = msgs.length;
      const preTokens = estTokens;
      const result = compactConversation(msgs);
      if (result.compacted) {
        logCompaction(dbgLog, preCount, preTokens, result.messages.length, estimateMessagesTokens(result.messages));
        // Replace msgs in place
        msgs.length = 0;
        msgs.push(...result.messages);
        estTokens = estimateMessagesTokens(msgs);
        const newPct = ((estTokens / config.maxTokens) * 100).toFixed(1);
        console.error(
          `  ${colorize("✔", C.green)} ${bold("Compacted:")} ${estTokens.toLocaleString()} tokens (${newPct}%) — ${result.messages.length} messages`,
        );
      } else {
        console.error(
          `  ${colorize("⚠", C.yellow)} Compaction not possible (too few rounds to summarize)`,
        );
      }
    }

    if (estTokens > config.maxTokens * 0.85 && estTokens <= config.maxTokens * 0.9) {
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

    // ── Auto-adjust max output tokens ──
    // Ensure max output + current context doesn't exceed maxTokens
    const availableHeadroom = Math.max(0, config.maxTokens - estTokens);
    const effectiveMaxOutput = Math.max(1, Math.min(config.maxOutputTokens, availableHeadroom));
    if (effectiveMaxOutput < config.maxOutputTokens && round === 1) {
      console.error(
        dim(`  [max output adjusted: ${effectiveMaxOutput.toLocaleString()} (headroom: ${availableHeadroom.toLocaleString()})]`),
      );
    }

    logRound(dbgLog, round, config.maxRounds, estTokens, config.maxTokens, effectiveMaxOutput);

    const roundStart = Date.now();
    spinner.start(round === 1
      ? `Round ${round}/${config.maxRounds} — ${config.model}`
      : `Round ${round}/${config.maxRounds}`);

    let response: ChatMessage;
    let usage;
    try {
      logMessagesSent(dbgLog, round, msgs);
      const result = await chatCompletion(msgs, tools, config, { effectiveMaxOutput });
      response = result.message;
      usage = result.usage;
      if (usage) {
        totalApiTokens += usage.totalTokens;
      }
      logResponse(dbgLog, round, response, usage);
    } catch (e) {
      logError(dbgLog, round, `API error: ${(e as Error).message}`);
      spinner.fail(`API error: ${(e as Error).message}`);
      throw e;
    }

    msgs.push(response);

    // Show detailed usage for this round
    if (usage) {
      console.error(
        dim(`  [API: ${usage.promptTokens.toLocaleString()} in + ${usage.completionTokens.toLocaleString()} out = ${usage.totalTokens.toLocaleString()} total | session: ${totalApiTokens.toLocaleString()}]`),
      );
    }

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
          logToolCall(dbgLog, round, tc.id, name, args);

          const result = await executeTool(name, args, {
            sandbox: config.sandbox,
            approve: config.approve,
            dryRun: config.dryRun,
            autoCommit: config.autoCommit,
            cwd: Deno.cwd(),
            askUser,
          });

          const elapsed = ((Date.now() - roundStart) / 1000).toFixed(1);
          console.error(formatToolResult(result.output, elapsed));
          logToolResult(dbgLog, round, tc.id, name, result.output, result.output.startsWith("Error"));

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
        if (result.startsWith("Error")) {
          hasErrors = true;
        }
      }

      // Check for restart signal
      for (const { result } of toolResults) {
        if (result === "RESTART_READY") {
          spinner.stop();
          console.error(`\n${colorize("🔄", C.cyan)} ${bold("Restarting with new version...")}`);
          const resumeFile = `${Deno.cwd()}/.ca_resume.json`;
          await saveConversation(msgs, resumeFile);
          return { messages: msgs, needsRestart: true };
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
        return { messages: msgs, needsRestart: false };
      }
    } else {
      // No tool calls — final response
      spinner.succeed(`Done (${round} round${round > 1 ? "s" : ""})`);
      if (response.content) {
        console.log(response.content);
      }
      return { messages: msgs, needsRestart: false };
    }
  }

  console.error(`${colorize("⚠", dim(""))} Reached max rounds (${config.maxRounds})`);
  return { messages: msgs, needsRestart: false };
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

// ─── Session Store (multi-session persistence) ──────────

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model: string;
}

export interface SessionIndex {
  sessions: SessionMeta[];
}

function getStoreDir(cwd: string): string {
  return `${cwd}/.ca/conversations`;
}

function getIndexPath(cwd: string): string {
  return `${getStoreDir(cwd)}/index.json`;
}

function getSessionPath(cwd: string, id: string): string {
  return `${getStoreDir(cwd)}/${id}.json`;
}

async function ensureStoreDir(cwd: string): Promise<void> {
  try {
    await Deno.mkdir(getStoreDir(cwd), { recursive: true });
  } catch { /* already exists */ }
}

async function readIndex(cwd: string): Promise<SessionIndex> {
  try {
    const raw = await Deno.readTextFile(getIndexPath(cwd));
    return JSON.parse(raw);
  } catch {
    return { sessions: [] };
  }
}

async function writeIndex(cwd: string, index: SessionIndex): Promise<void> {
  await ensureStoreDir(cwd);
  await Deno.writeTextFile(getIndexPath(cwd), JSON.stringify(index, null, 2));
}

export async function listSessions(cwd: string): Promise<SessionMeta[]> {
  const index = await readIndex(cwd);
  return index.sessions.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function createSession(
  cwd: string,
  model: string,
  title?: string,
): Promise<string> {
  const id = crypto.randomUUID().substring(0, 8);
  const now = new Date().toISOString();
  const index = await readIndex(cwd);
  index.sessions.push({
    id,
    title: title ?? `Session ${id}`,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    model,
  });
  await writeIndex(cwd, index);
  // Create empty session file
  await Deno.writeTextFile(getSessionPath(cwd, id), JSON.stringify({
    version: VERSION,
    timestamp: now,
    messages: [],
  }, null, 2));
  return id;
}

export async function saveSession(
  cwd: string,
  id: string,
  messages: ChatMessage[],
  model: string,
): Promise<void> {
  await ensureStoreDir(cwd);
  const exportData: ConversationExport = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    messages,
  };
  await Deno.writeTextFile(getSessionPath(cwd, id), JSON.stringify(exportData, null, 2));

  // Update index
  const index = await readIndex(cwd);
  const session = index.sessions.find((s) => s.id === id);
  if (session) {
    session.updatedAt = new Date().toISOString();
    session.messageCount = messages.length;
    session.model = model;
    // Update title from first user message
    if (session.title.startsWith("Session ") && messages.length > 0) {
      const firstUser = messages.find((m) => m.role === "user");
      if (firstUser?.content) {
        session.title = firstUser.content.substring(0, 80).replace(/\n/g, " ");
      }
    }
    await writeIndex(cwd, index);
  }
}

export async function loadSession(cwd: string, id: string): Promise<ChatMessage[]> {
  const raw = await Deno.readTextFile(getSessionPath(cwd, id));
  const data: ConversationExport = JSON.parse(raw);
  if (!data.version || !Array.isArray(data.messages)) {
    throw new Error("Invalid session file format");
  }
  return data.messages;
}

export async function deleteSession(cwd: string, id: string): Promise<void> {
  // Remove session file
  try {
    await Deno.remove(getSessionPath(cwd, id));
  } catch { /* already gone */ }
  // Remove from index
  const index = await readIndex(cwd);
  index.sessions = index.sessions.filter((s) => s.id !== id);
  await writeIndex(cwd, index);
}

// ─── Subagent Runner ──────────────────────────────────

export async function runSubagent(input: SubagentInput): Promise<SubagentResult> {
  const cwd = Deno.cwd();
  const filesExamined = new Set<string>();
  const keyFindings: string[] = [];
  let totalTokens = 0;

  // Build restricted config
  const tools = input.tools ?? ["read_file", "search_files", "list_directory"];
  const config: AgentConfig = {
    model: Deno.env.get("CA_MODEL") ?? "deepseek-v4-pro",
    apiKey: Deno.env.get("CA_API_KEY") ?? "",
    apiBase: (Deno.env.get("CA_API_BASE") ?? "https://api.deepseek.com/v1").replace(/\/+$/, ""),
    maxTokens: input.max_tokens ?? 50000,
    maxOutputTokens: Math.min(input.max_tokens ?? 50000, 384000),
    maxRounds: input.max_rounds ?? 20,
    maxRetries: 2,
    temperature: 0.0,
    stop: "",
    responseFormat: "",
    logprobs: false,
    userId: "",
    thinking: false,
    reasoningEffort: "",
    stream: false,
    sandbox: false,
    approve: false,
    dryRun: false,
    autoCommit: false,
    tools: {
      read_file: tools.includes("read_file"),
      write_file: tools.includes("write_file"),
      run_command: tools.includes("run_command"),
      search_files: tools.includes("search_files"),
      list_directory: tools.includes("list_directory"),
      ask_user: false,
      apply_diff: tools.includes("apply_diff"),
      restart_self: false,
      test_web: false,
      spawn_subagent: false,
      check_subagent: false,
      await_subagent: false,
    },
  };

  const systemPrompt = `You are a subagent of CA. Complete the assigned task efficiently and report back.

## Task
${input.task}

## Available Tools
${tools.map(t => `- ${t}`).join("\n")}

## Instructions
- Work efficiently. Your context window is limited (${config.maxTokens} tokens).
- Focus ONLY on the assigned task. Do not explore tangents.
- Track which files you examine and note important findings.
- When finished, provide a clear, structured summary of what you found.
- If you cannot complete the task, explain why clearly.
- You do NOT have ask_user — handle ambiguities yourself.
- Be thorough: read files before reporting on them.`;

  const defs = buildToolDefs(config);
  const msgs: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Complete the following task:\n\n${input.task}` },
  ];

  let finalContent = "";

  for (let round = 1; round <= config.maxRounds; round++) {
    const estTokens = estimateMessagesTokens(msgs);
    if (estTokens > config.maxTokens * 0.9) {
      finalContent = "Token budget nearly exhausted. Reporting findings so far.";
      break;
    }

    // Auto-adjust max output tokens for subagent too
    const availableHeadroom = Math.max(0, config.maxTokens - estTokens);
    const effectiveMaxOutput = Math.max(1, Math.min(config.maxOutputTokens, availableHeadroom));

    let response: ChatMessage;
    try {
      const result = await chatCompletion(msgs, defs, config, { effectiveMaxOutput });
      response = result.message;
      if (result.usage) totalTokens += result.usage.totalTokens;
    } catch (e) {
      return {
        id: input.id,
        status: "error",
        summary: `API error: ${(e as Error).message}`,
        rounds: round,
        tokens_used: totalTokens,
        files_examined: [...filesExamined],
        key_findings: keyFindings,
      };
    }

    msgs.push(response);

    if (response.tool_calls?.length) {
      const toolResults = await Promise.all(response.tool_calls.map(async (tc) => {
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments); } catch { return { tc, result: `Error: Invalid JSON` }; }

        // Track file access
        if (name === "read_file" && args.path) filesExamined.add(args.path as string);
        if (name === "search_files" && args.path) filesExamined.add(args.path as string);

        const result = await executeTool(name, args, {
          sandbox: false,
          approve: false,
          dryRun: false,
          autoCommit: false,
          cwd,
          askUser: undefined,
        });

        return { tc, result: result.output };
      }));

      for (const { tc, result } of toolResults) {
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    } else {
      finalContent = response.content ?? "";
      break;
    }
  }

  // Build result from final content
  const summary = finalContent || "Task completed but subagent produced no final content.";

  // Try to extract findings from the summary (lines starting with - or *)
  const lines = summary.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if ((trimmed.startsWith("- ") || trimmed.startsWith("* ")) && !trimmed.match(/^[-*]\s*`/)) {
      const finding = trimmed.replace(/^[-*]\s+/, "");
      if (finding.length > 10 && finding.length < 200) {
        keyFindings.push(finding);
      }
    }
  }

  return {
    id: input.id,
    status: finalContent ? "completed" : "max_rounds",
    summary,
    rounds: msgs.filter(m => m.role === "assistant").length,
    tokens_used: totalTokens,
    files_examined: [...filesExamined].slice(0, 20),
    key_findings: keyFindings.slice(0, 10),
  };
}

export async function updateSessionTitle(cwd: string, id: string, title: string): Promise<void> {
  const index = await readIndex(cwd);
  const session = index.sessions.find((s) => s.id === id);
  if (session) {
    session.title = title;
    await writeIndex(cwd, index);
  }
}
