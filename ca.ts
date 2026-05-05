#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-net --allow-env

import type { ChatMessage, AgentConfig } from "./ca_types.ts";
import { VERSION } from "./ca_types.ts";
import { initConfig, getConfig, applyCliOverrides } from "./ca_config.ts";
import { buildSystemContent, run, saveConversation, loadConversation } from "./ca_agent.ts";
import type { RunResult } from "./ca_agent.ts";
import { C, colorize, dim, bold, printBanner, separator, highlightCode } from "./ca_ui.ts";
import { startWebServer, type WebServerHandle } from "./ca_web.ts";

// ─── Global State ──────────────────────────────────────

let shuttingDown = false;
let abortController: AbortController | null = null;

function setupSignalHandlers(): void {
  const handler = () => {
    if (shuttingDown) {
      console.error(dim("\nForcing exit..."));
      Deno.exit(1);
    }
    shuttingDown = true;
    console.error(`\n${colorize("⚠", C.yellow)} ${bold("Interrupted. Finishing current operation...")}`);
    console.error(dim("  Press Ctrl+C again to force exit."));
    if (abortController) {
      abortController.abort();
    }
  };
  Deno.addSignalListener("SIGINT", handler);
  Deno.addSignalListener("SIGTERM", handler);
}

// ─── Restart Helper ────────────────────────────────────

function ensureApiKey(config: AgentConfig): void {
  const isLocal = config.apiBase.includes("localhost") ||
    config.apiBase.includes("127.0.0.1");
  if (!config.apiKey && !isLocal) {
    console.error(
      `${colorize("✘", C.red)} ${bold("Error:")} CA_API_KEY not set. Use --api-key, CA_API_KEY env, or a local API base.`,
    );
    Deno.exit(1);
  }
}

async function performRestart(resumeFile: string): Promise<void> {
  console.error(dim("  Spawning new CA process..."));
  const child = new Deno.Command("deno", {
    args: ["run", "-A", "ca.ts", "--resume", resumeFile],
    cwd: Deno.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  // Wait for the child to finish — keeps the foreground process group
  // so the child can read from stdin without EIO errors
  const status = await child.status;
  Deno.exit(status.code);
}

// ─── CLI ───────────────────────────────────────────────

function help(): void {
  const b = (s: string) => bold(s);
  const d = (s: string) => dim(s);
  const c = (s: string) => colorize(s, C.cyan);

  console.log(`${b(`CA ${VERSION}`)} ${d("- Self-Evolving Coding Agent")}

${b("Usage:")}
  deno run -A ca.ts ${c("[options]")} ${d("<prompt>")}
  deno run -A ca.ts ${c("[options]")} ${c("-i")}              ${d("(interactive mode)")}

${b("Options:")}
  ${c("-h, --help")}                      ${d("Show this help")}
  ${c("-v, --version")}                   ${d("Show version")}
  ${c("-i, --interactive")}               ${d("Start interactive session")}
  ${c("-m, --model")} ${d("<name>")}              ${d("Model (default: deepseek-v4-pro)")}
  ${c("--api-base")} ${d("<url>")}                ${d("API base URL")}
  ${c("--api-key")} ${d("<key>")}                 ${d("API key")}
  ${c("--max-tokens")} ${d("<n>")}                ${d("Max tokens per response (default: 1,000,000)")}
  ${c("--max-rounds")} ${d("<n>")}                ${d("Max agent rounds (default: 100)")}
  ${c("--max-retries")} ${d("<n>")}              ${d("Max API retry attempts (default: 3)")}
  ${c("--temperature")} ${d("<f>")}               ${d("Temperature (0-2, default: 0.0)")}
  ${c("--top-p")} ${d("<f>")}                     ${d("Top P nucleus sampling (0-1)")}
  ${c("--stop")} ${d("<seq>")}                    ${d("Stop sequence(s), comma-separated")}
  ${c("--response-format")} ${d("<type>")}        ${d("Response format (text, json)")}
  ${c("--logprobs")}                      ${d("Return log probabilities")}
  ${c("--top-logprobs")} ${d("<n>")}              ${d("Most likely tokens per position (max 20)")}
  ${c("--user-id")} ${d("<id>")}                  ${d("User ID for KVCache isolation")}
  ${c("--stream")}                        ${d("Enable streaming responses")}
  ${c("--thinking")}                      ${d("Enable thinking/reasoning mode")}
  ${c("--reasoning-effort")} ${d("<level>")}      ${d("Reasoning effort (high, max)")}
  ${c("--system-prompt")} ${d("<file>")}          ${d("Path to system prompt file")}
  ${c("--sandbox")}                       ${d("Enable path sandboxing (default: on)")}
  ${c("--no-sandbox")}                    ${d("Disable path sandboxing")}
  ${c("--approve")}                       ${d("Require approval for writes & commands")}
  ${c("--resume")} ${d("<file>")}                ${d("Resume from a saved conversation")}
  ${c("--no-auto-commit")}                ${d("Disable git auto-commit before writes")}
  ${c("--auto-commit")}                  ${d("Enable git auto-commit (default)")}
  ${c("--dry-run")}                       ${d("Show what would be done without doing it")}
  ${c("--web")}                          ${d("Start web UI on localhost:9420")}
  ${c("--web-port")} ${d("<port>")}              ${d("Web UI port (default: 9420)")}

${b("Environment:")}
  CA_MODEL, CA_API_KEY, CA_API_BASE, CA_MAX_TOKENS, CA_MAX_ROUNDS, CA_MAX_RETRIES,
  CA_TEMPERATURE, CA_TOP_P, CA_STOP, CA_RESPONSE_FORMAT, CA_LOGPROBS,
  CA_TOP_LOGPROBS, CA_USER_ID, CA_STREAM, CA_THINKING, CA_REASONING_EFFORT,
  CA_SYSTEM_PROMPT, CA_SYSTEM_PROMPT_FILE, CA_SANDBOX, CA_APPROVE, CA_DRY_RUN, CA_AUTO_COMMIT

${b("Config File:")}  ${d(".ca.json in project root or parent directories")}

${b("Examples:")}
  ${d("# Basic usage")}
  CA_API_KEY=sk-... deno run -A ca.ts ${c("\"write a hello world script in rust\"")}

  ${d("# Interactive mode")}
  CA_API_KEY=sk-... deno run -A ca.ts ${c("-i")}

  ${d("# With thinking enabled")}
  CA_API_KEY=sk-... CA_THINKING=1 deno run -A ca.ts ${c("-i")}

  ${d("# Local llama.cpp server")}
  CA_MODEL=qwen3-6b CA_API_BASE=http://localhost:8080/v1 \\
    deno run -A ca.ts ${c("\"review the codebase\"")}

  ${d("# Self-improvement")}
  CA_API_KEY=sk-... deno run -A ca.ts \\
    ${c("\"read ca.ts and all ca_*.ts modules, analyze them, and improve error handling\"")}`);
}

// ─── Interactive Mode ──────────────────────────────────

async function interactive(existingMessages?: ChatMessage[]): Promise<void> {
  const config = getConfig();

  // Build initial system prompt
  const systemContent = await buildSystemContent(config, Deno.cwd());

  let messages: ChatMessage[];
  if (existingMessages) {
    messages = existingMessages;
    // Update system prompt with current config
    if (messages[0]?.role === "system") {
      messages[0].content = systemContent;
    }
  } else {
    messages = [
      { role: "system", content: systemContent },
    ];
  }

  printBanner(config);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let stdinBuffer = "";

  async function readLine(promptStr: string): Promise<string | null> {
    const nlIndex = stdinBuffer.indexOf("\n");
    if (nlIndex !== -1) {
      const line = stdinBuffer.substring(0, nlIndex);
      stdinBuffer = stdinBuffer.substring(nlIndex + 1);
      return line.replace(/\r$/, "");
    }

    await Deno.stdout.write(encoder.encode(promptStr));

    const buf = new Uint8Array(4096);
    while (true) {
      const n = await Deno.stdin.read(buf);
      if (n === null) {
        if (stdinBuffer.length > 0) {
          const line = stdinBuffer;
          stdinBuffer = "";
          return line;
        }
        return null;
      }

      stdinBuffer += decoder.decode(buf.subarray(0, n));

      const nlIdx = stdinBuffer.indexOf("\n");
      if (nlIdx !== -1) {
        const line = stdinBuffer.substring(0, nlIdx);
        stdinBuffer = stdinBuffer.substring(nlIdx + 1);
        return line.replace(/\r$/, "");
      }
    }
  }

  // askUser callback for interactive mode
  async function askUserCallback(question: string): Promise<string> {
    console.error(`\n${colorize("💬", C.cyan)} ${bold("Agent asks:")} ${question}`);
    const answer = await readLine(`${colorize("❯❯ ", C.cyan)}`);
    return answer?.trim() ?? "";
  }

  // Multi-line input support
  async function readMultiLine(): Promise<string | null> {
    const lines: string[] = [];
    let firstLine = true;

    while (true) {
      const promptStr = firstLine
        ? colorize("❯ ", C.cyan)
        : colorize("│ ", dim(""));

      const line = await readLine(promptStr);
      firstLine = false;

      if (line === null) {
        // EOF
        return lines.length > 0 ? lines.join("\n") : null;
      }

      // Empty line on first prompt = skip
      if (lines.length === 0 && line.trim() === "") {
        return "";
      }

      // Check for termination: \e on its own line (backslash + 'e')
      if (line.trim() === "\\e") {
        return lines.join("\n");
      }

      lines.push(line);
    }
  }

  console.error(dim("Type \\e on a new line to submit multi-line input. /help for commands."));
  console.error("");

  while (true) {
    const input = await readMultiLine();
    if (input === null) break;

    const trimmed = input.trim();

    // Handle special commands
    if (trimmed.startsWith("/")) {
      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const rest = parts.slice(1).join(" ");

      switch (cmd) {
        case "/upgrade": {
          console.error(`\n${colorize("🔄", C.cyan)} ${bold("Self-upgrade initiated...")}`);
          console.error(dim("  The agent will modify source files, then call restart_self."));
          console.error(dim("  Type /upgrade-go when ready, or just tell CA to upgrade itself."));
          continue;
        }

        case "/upgrade-go": {
          console.error(`\n${colorize("🔄", C.cyan)} ${bold("Running self-upgrade...")}`);
          const upgradePrompt = "You are asked to upgrade yourself. Read all ca_*.ts modules, analyze the codebase for improvements, implement them, run deno check and deno test to verify, and then call restart_self with confirm=true. Focus on: reducing code duplication, improving error handling, adding missing features, and making the code more robust. Be thorough.";
          try {
            const result = await run(upgradePrompt, messages, {
              config,
              askUser: askUserCallback,
            });
            messages = result.messages;
            if (result.needsRestart) {
              await performRestart(`${Deno.cwd()}/.ca_resume.json`);
            }
          } catch (e) {
            console.error(`\n${colorize("✘", C.red)} ${bold("Upgrade error:")} ${(e as Error).message}`);
          }
          continue;
        }

        case "/quit":
        case "/exit":
          console.error(colorize("Goodbye!", C.green));
          return;

        case "/help":
          console.error(`\n${bold("Commands:")}`);
          console.error(`  ${colorize("/help", C.cyan)}         ${dim("Show this help")}`);
          console.error(`  ${colorize("/history", C.cyan)}      ${dim("Show conversation history")}`);
          console.error(`  ${colorize("/clear", C.cyan)}        ${dim("Clear conversation (keeps system prompt)")}`);
          console.error(`  ${colorize("/model", C.cyan)}        ${dim("Show current model and config")}`);
          console.error(`  ${colorize("/system", C.cyan)}       ${dim("View or set system prompt (/system <text>)")}`);
          console.error(`  ${colorize("/context", C.cyan)}      ${dim("Refresh project context")}`);
          console.error(`  ${colorize("/save", C.cyan)} <file>  ${dim("Save conversation to file")}`);
          console.error(`  ${colorize("/load", C.cyan)} <file>  ${dim("Load conversation from file")}`);
          console.error(`  ${colorize("/edit", C.cyan)}         ${dim("Remove last exchange (user+assistant)")}`);
          console.error(`  ${colorize("/upgrade", C.cyan)}      ${dim("Initiate self-upgrade sequence")}`);
          console.error(`  ${colorize("/upgrade-go", C.cyan)}   ${dim("Execute self-upgrade now")}`);
          console.error(`  ${colorize("/tokens", C.cyan)}       ${dim("Estimate token usage")}`);
          console.error(`  ${colorize("/set", C.cyan)} <k> <v>  ${dim("Set config: maxRounds, maxRetries, maxTokens, temperature, ...")}`);
          console.error(`  ${colorize("/quit", C.cyan)}         ${dim("Exit")}`);
          console.error(`  ${colorize("/exit", C.cyan)}         ${dim("Exit")}`);
          console.error(`\n${dim("Multi-line: Type \\e on a new line to submit.")}`);
          console.error("");
          continue;

        case "/history": {
          const sep = separator();
          console.error(`\n${sep}`);
          console.error(bold("Conversation History"));
          console.error(sep);
          let msgIdx = 0;
          for (const msg of messages) {
            if (msg.role === "system") {
              const preview = (msg.content ?? "").length > 200
                ? (msg.content ?? "").substring(0, 200) + dim("...")
                : (msg.content ?? "");
              console.error(`\n${bold(colorize("system", C.cyan))}:`);
              console.error(`  ${dim(preview)}`);
              continue;
            }
            msgIdx++;
            const roleLabel = msg.role === "user"
              ? colorize(`[${msgIdx}] you`, C.green)
              : msg.role === "assistant"
              ? colorize(`[${msgIdx}] ca`, C.cyan)
              : colorize(`[${msgIdx}] ${msg.role}`, C.yellow);
            const content = msg.content ?? "";
            const preview = content.length > 300
              ? content.substring(0, 300) + dim("...")
              : content;
            console.error(`\n${bold(roleLabel)}:`);
            if (preview) console.error(`  ${dim(preview)}`);
            if (msg.tool_calls?.length) {
              for (const tc of msg.tool_calls) {
                console.error(
                  `  ${colorize("→", C.magenta)} ${tc.function.name}(${dim(tc.function.arguments.substring(0, 120))})`,
                );
              }
            }
          }
          console.error(`\n${sep}\n`);
          continue;
        }

        case "/clear":
          messages.length = 1; // keep system prompt
          console.error(colorize("Conversation cleared.", C.green));
          continue;

        case "/model": {
          const sep = separator("─", 40);
          console.error(`\n${sep}`);
          console.error(`${bold("Model:")} ${config.model}`);
          console.error(`${bold("API Base:")} ${config.apiBase}`);
          console.error(`${bold("Max tokens:")} ${config.maxTokens}`);
          console.error(`${bold("Max rounds:")} ${config.maxRounds}`);
          console.error(`${bold("Max retries:")} ${config.maxRetries}`);
          console.error(`${bold("Temperature:")} ${config.temperature}`);
          if (config.topP !== undefined) console.error(`${bold("Top P:")} ${config.topP}`);
          if (config.stop) console.error(`${bold("Stop:")} ${config.stop}`);
          if (config.responseFormat) console.error(`${bold("Response format:")} ${config.responseFormat}`);
          console.error(`${bold("Stream:")} ${config.stream ? "enabled" : "disabled"}`);
          console.error(`${bold("Thinking:")} ${config.thinking ? "enabled" : "disabled"}`);
          if (config.reasoningEffort) console.error(`${bold("Reasoning effort:")} ${config.reasoningEffort}`);
          console.error(`${bold("Sandbox:")} ${config.sandbox ? "enabled" : "disabled"}`);
          console.error(`${bold("Approve:")} ${config.approve ? "enabled" : "disabled"}`);
          console.error(`${bold("Dry run:")} ${config.dryRun ? "enabled" : "disabled"}`);
          console.error(`${bold("Tools:")} ${Object.entries(config.tools).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
          console.error(`${sep}\n`);
          continue;
        }

        case "/system":
          if (rest) {
            // Set system prompt
            messages[0].content = rest;
            // Also update the config
            applyCliOverrides({ systemPrompt: rest });
            console.error(colorize("System prompt updated.", C.green));
          } else {
            // View system prompt
            const sep = separator();
            console.error(`\n${sep}`);
            console.error(bold("System Prompt:"));
            console.error(dim(messages[0].content ?? "(none)"));
            console.error(`${sep}\n`);
          }
          continue;

        case "/context":
          try {
            const newSystemContent = await buildSystemContent(config, Deno.cwd());
            messages[0].content = newSystemContent;
            console.error(colorize("Project context refreshed.", C.green));
          } catch (e) {
            console.error(`${colorize("✘", C.red)} Failed: ${(e as Error).message}`);
          }
          continue;

        case "/save":
          if (!rest) {
            console.error(`${colorize("✘", C.red)} Usage: /save <filepath>`);
            continue;
          }
          try {
            await saveConversation(messages, rest);
          } catch (e) {
            console.error(`${colorize("✘", C.red)} Save failed: ${(e as Error).message}`);
          }
          continue;

        case "/load":
          if (!rest) {
            console.error(`${colorize("✘", C.red)} Usage: /load <filepath>`);
            continue;
          }
          try {
            const loaded = await loadConversation(rest);
            messages.length = 0;
            messages.push(...loaded);
            // Update system prompt with current config
            if (messages[0]?.role === "system") {
              messages[0].content = systemContent;
            }
            console.error(colorize(`Loaded ${loaded.length} messages.`, C.green));
          } catch (e) {
            console.error(`${colorize("✘", C.red)} Load failed: ${(e as Error).message}`);
          }
          continue;

        case "/edit": {
          // Remove last user message and assistant response(s)
          let lastUserIdx = -1;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") {
              lastUserIdx = i;
              break;
            }
          }
          if (lastUserIdx >= 0) {
            const removed = messages.splice(lastUserIdx);
            console.error(
              colorize(`Removed ${removed.length} messages (last user exchange).`, C.green),
            );
          } else {
            console.error(`${colorize("✘", C.red)} No user messages to remove.`);
          }
          continue;
        }

        case "/tokens": {
          const { estimateMessagesTokens } = await import("./ca_client.ts");
          const est = estimateMessagesTokens(messages);
          const pct = ((est / config.maxTokens) * 100).toFixed(1);
          console.error(
            `${bold("Estimated tokens:")} ~${est} / ${config.maxTokens} (${pct}%)`,
          );
          continue;
        }

        case "/set": {
          const setParts = rest.split(/\s+/);
          const key = setParts[0];
          const val = setParts[1];

          if (!key || val === undefined) {
            console.error(`${colorize("✘", C.red)} Usage: /set <key> <value>`);
            console.error(dim("  Keys: maxRounds, maxRetries, maxTokens, temperature,"));
            console.error(dim("        topP, stream (on/off), thinking (on/off),"));
            console.error(dim("        approve (on/off), dryRun (on/off), sandbox (on/off),"));
            console.error(dim("        autoCommit (on/off), model, userId, stop, responseFormat"));
            continue;
          }

          // Map string keys to config fields and their types
          function setConfigValue(k: string, v: string): boolean {
            switch (k) {
              case "maxRounds": case "maxRetries": case "maxTokens": {
                const n = parseInt(v);
                if (isNaN(n)) return false;
                const ov: Partial<AgentConfig> = {}; ov[k] = n; applyCliOverrides(ov);
                console.error(colorize(`${k} = ${n}`, C.green));
                return true;
              }
              case "temperature": case "topP": {
                const n = parseFloat(v);
                if (isNaN(n)) return false;
                const ov: Partial<AgentConfig> = {}; (ov as unknown as Record<string, unknown>)[k] = n;
                applyCliOverrides(ov);
                console.error(colorize(`${k} = ${n}`, C.green));
                return true;
              }
              case "stream": case "thinking": case "approve":
              case "dryRun": case "sandbox": case "autoCommit": {
                const on = v === "on" || v === "1" || v === "true";
                const ov: Partial<AgentConfig> = {};
                (ov as unknown as Record<string, unknown>)[k] = on;
                applyCliOverrides(ov);
                console.error(colorize(`${k} = ${on ? "on" : "off"}`, C.green));
                return true;
              }
              case "apiKey": case "userId": case "stop":
              case "responseFormat": case "model": {
                const ov: Partial<AgentConfig> = {};
                (ov as unknown as Record<string, unknown>)[k] = v;
                applyCliOverrides(ov);
                const display = k === "apiKey" ? (v.length > 8 ? v.substring(0, 8) + "..." : v) : v;
                console.error(colorize(`${k} = ${display}`, C.green));
                return true;
              }
              default: return false;
            }
          }

          const configAffectingKeys = new Set(["sandbox", "approve", "dryRun", "thinking", "systemPrompt"]);
          const wasConfigAffecting = configAffectingKeys.has(key);

          const success = setConfigValue(key, val);
          if (!success) {
            console.error(`${colorize("✘", C.red)} Unknown key: ${key}`);
            console.error(dim("  Valid keys: maxRounds, maxRetries, maxTokens, temperature,"));
            console.error(dim("             topP, stream, thinking, approve, dryRun,"));
            console.error(dim("             sandbox, autoCommit, model, userId, stop,"));
            console.error(dim("             responseFormat, apiKey"));
          } else if (wasConfigAffecting && messages.length > 0 && messages[0].role === "system") {
            // Refresh system prompt to reflect config changes
            const updatedConfig = getConfig();
            const newSystemContent = await buildSystemContent(updatedConfig, Deno.cwd());
            messages[0].content = newSystemContent;
            console.error(dim("  (system prompt updated to reflect config changes)"));
          }
          continue;
        }

        default:
          console.error(
            `${colorize("✘", C.red)} Unknown command: ${trimmed}. ${dim("Type /help for available commands.")}`,
          );
          continue;
      }
    }

    // Shell passthrough: !cmd runs directly without agent
    if (trimmed.startsWith("!")) {
      const shellCmd = trimmed.substring(1).trim();
      if (shellCmd) {
        console.error(dim(`! ${shellCmd}`));
        try {
          const proc = new Deno.Command("bash", {
            args: ["-c", shellCmd],
            cwd: Deno.cwd(),
            stdout: "inherit",
            stderr: "inherit",
          });
          const { code } = await proc.output();
          if (code !== 0) console.error(dim(`[exit: ${code}]`));
        } catch (e) {
          console.error(`${colorize("✘", C.red)} ${(e as Error).message}`);
        }
      }
      continue;
    }

    if (!trimmed) continue;

    // Run the agent with the current message
    abortController = new AbortController();
    try {
      const result = await run(trimmed, messages, {
        config,
        askUser: askUserCallback,
        signal: abortController.signal,
      });
      messages = result.messages;
      if (result.needsRestart) {
        await performRestart(`${Deno.cwd()}/.ca_resume.json`);
      }
    } catch (e) {
      console.error(
        `\n${colorize("✘", C.red)} ${bold("Error:")} ${(e as Error).message}`,
      );
    } finally {
      abortController = null;
    }
  }
}

// ─── Main ──────────────────────────────────────────────

async function main(): Promise<void> {
  setupSignalHandlers();
  const args = Deno.args;
  let promptParts: string[] = [];
  let interactiveMode = false;
  let webMode = false;
  let webPort = 9420;
  const cliOverrides: Partial<AgentConfig> = {};
  let i = 0;

  while (i < args.length) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      help();
      Deno.exit(0);
    } else if (a === "-v" || a === "--version") {
      console.log(`CA ${VERSION}`);
      Deno.exit(0);
    } else if (a === "-i" || a === "--interactive") {
      interactiveMode = true;
      i++;
    } else if ((a === "-m" || a === "--model") && args[i + 1]) {
      cliOverrides.model = args[++i];
      i++;
    } else if (a === "--api-base" && args[i + 1]) {
      cliOverrides.apiBase = args[++i];
      i++;
    } else if (a === "--api-key" && args[i + 1]) {
      cliOverrides.apiKey = args[++i];
      i++;
    } else if (a === "--max-tokens" && args[i + 1]) {
      cliOverrides.maxTokens = parseInt(args[++i]);
      i++;
    } else if (a === "--max-rounds" && args[i + 1]) {
      cliOverrides.maxRounds = parseInt(args[++i]);
      i++;
    } else if (a === "--max-retries" && args[i + 1]) {
      cliOverrides.maxRetries = parseInt(args[++i]);
      i++;
    } else if (a === "--temperature" && args[i + 1]) {
      cliOverrides.temperature = parseFloat(args[++i]);
      i++;
    } else if (a === "--top-p" && args[i + 1]) {
      cliOverrides.topP = parseFloat(args[++i]);
      i++;
    } else if (a === "--stop" && args[i + 1]) {
      cliOverrides.stop = args[++i];
      i++;
    } else if (a === "--response-format" && args[i + 1]) {
      cliOverrides.responseFormat = args[++i];
      i++;
    } else if (a === "--logprobs") {
      cliOverrides.logprobs = true;
      i++;
    } else if (a === "--top-logprobs" && args[i + 1]) {
      cliOverrides.topLogprobs = parseInt(args[++i]);
      i++;
    } else if (a === "--user-id" && args[i + 1]) {
      cliOverrides.userId = args[++i];
      i++;
    } else if (a === "--stream") {
      cliOverrides.stream = true;
      i++;
    } else if (a === "--thinking") {
      cliOverrides.thinking = true;
      i++;
    } else if (a === "--reasoning-effort" && args[i + 1]) {
      cliOverrides.reasoningEffort = args[++i];
      i++;
    } else if (a === "--system-prompt" && args[i + 1]) {
      cliOverrides.systemPromptFile = args[++i];
      i++;
    } else if (a === "--sandbox") {
      cliOverrides.sandbox = true;
      i++;
    } else if (a === "--no-sandbox") {
      cliOverrides.sandbox = false;
      i++;
    } else if (a === "--approve") {
      cliOverrides.approve = true;
      i++;
    } else if (a === "--resume" && args[i + 1]) {
      cliOverrides.resumeFile = args[++i];
      i++;
    } else if (a === "--no-auto-commit") {
      cliOverrides.autoCommit = false;
      i++;
    } else if (a === "--auto-commit") {
      cliOverrides.autoCommit = true;
      i++;
    } else if (a === "--dry-run") {
      cliOverrides.dryRun = true;
      i++;
    } else if (a === "--web") {
      webMode = true;
      i++;
    } else if (a === "--web-port" && args[i + 1]) {
      webPort = parseInt(args[++i]);
      i++;
    } else {
      promptParts.push(a);
      i++;
    }
  }

  // Initialize configuration (env -> file -> CLI)
  await initConfig(cliOverrides);
  const config = getConfig();

  // Resume from saved conversation
  if (config.resumeFile) {
    console.error(`${colorize("📂", C.cyan)} ${bold("Resuming conversation...")}`);
    try {
      const msgs = await loadConversation(config.resumeFile);
      const systemContent = await buildSystemContent(config, Deno.cwd());
      if (msgs[0]?.role === "system") {
        msgs[0].content = systemContent;
      }
      console.error(colorize("📂 Conversation resumed. Continue where you left off.", C.green));
      console.error("");
      await interactive(msgs);
      return;
    } catch (e) {
      console.error(`${colorize("✘", C.red)} ${bold("Resume failed:")} ${(e as Error).message}`);
      Deno.exit(1);
    }
  }

  // Web UI mode — starts as non-blocking background task
  // Must start before interactive/single-shot so both can coexist
  if (webMode) {
    ensureApiKey(config);
    console.error(`${colorize("🌐", C.cyan)} ${bold("Starting CA Web UI on http://localhost:" + webPort + " ...")}`);
    const webServer = startWebServer(config, webPort);
    // Fire and forget: web server runs in background; if it fails, log and continue
    webServer.done.catch((e: Error) => {
      console.error(`${colorize("✘", C.red)} Web server error: ${e.message}`);
    });
    // Don't return — fall through to interactive mode or single-shot below
  }

  // Interactive mode
  if (interactiveMode) {
    ensureApiKey(config);
    await interactive();
    return;
  }

  // If web mode is on and no explicit mode/prompt, default to interactive
  if (webMode && !interactiveMode && promptParts.length === 0) {
    interactiveMode = true;
  }

  // Enter interactive mode if set (may have been set by web mode fallthrough)
  if (interactiveMode) {
    ensureApiKey(config);
    await interactive();
    return;
  }

  // Single-shot mode
  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    console.error(
      `${colorize("✘", C.red)} ${bold("Error:")} No prompt. Use -h for help, or -i for interactive mode.`,
    );
    Deno.exit(1);
  }

  ensureApiKey(config);

  const result = await run(prompt, undefined, { config });
  if (result.needsRestart) {
    await performRestart(`${Deno.cwd()}/.ca_resume.json`);
  }
}

main().catch((e) => {
  console.error(`\n${colorize("✘", C.red)} ${bold("Fatal:")} ${(e as Error).message}`);
  Deno.exit(1);
});
