import type { ChatMessage, AgentConfig, UsageInfo } from "./ca_types.ts";
import { VERSION } from "./ca_types.ts";
import { buildToolDefs, executeTool } from "./ca_tools.ts";
import { chatCompletion, chatCompletionStream, estimateMessagesTokens, type StreamEvent } from "./ca_client.ts";
import { buildSystemContent, saveConversation } from "./ca_agent.ts";

// ─── Web UI Event Types ─────────────────────────────────

export type WebEvent =
  | { type: "banner"; model: string; base: string; flags: string[] }
  | { type: "context"; content: string }
  | { type: "thinking"; round: number; maxRounds: number }
  | { type: "token_warning"; used: number; max: number; pct: string }
  | { type: "assistant_text"; content: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: string; error: boolean; diff?: string }
  | { type: "tool_error"; id: string; name: string; message: string }
  | { type: "warning"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; rounds: number; usage?: UsageInfo }
  | { type: "restart" }
  | { type: "aborted" };

// ─── Streaming Agent Loop ──────────────────────────────

export interface WebAgentOptions {
  config: AgentConfig;
  signal?: AbortSignal;
  onEvent: (event: WebEvent) => void;
}

export async function runWebAgent(
  prompt: string,
  messages: ChatMessage[] | undefined,
  opts: WebAgentOptions,
): Promise<{ messages: ChatMessage[]; needsRestart: boolean }> {
  const { config, signal, onEvent } = opts;
  const tools = buildToolDefs(config);
  const systemContent = await buildSystemContent(config, Deno.cwd());

  const msgs = messages ?? [
    { role: "system" as const, content: systemContent },
  ];

  if (messages && messages.length > 0 && messages[0].role === "system") {
    messages[0].content = systemContent;
  }

  msgs.push({ role: "user", content: prompt });

  let totalTokens = estimateMessagesTokens(msgs);

  for (let round = 1; round <= config.maxRounds; round++) {
    if (signal?.aborted) {
      onEvent({ type: "aborted" });
      return { messages: msgs, needsRestart: false };
    }

    const estTokens = estimateMessagesTokens(msgs);
    if (estTokens > config.maxTokens * 0.85) {
      onEvent({
        type: "token_warning",
        used: estTokens,
        max: config.maxTokens,
        pct: ((estTokens / config.maxTokens) * 100).toFixed(0),
      });
    }
    if (estTokens > config.maxTokens) {
      onEvent({ type: "error", message: `Token budget exceeded: ~${estTokens} > ${config.maxTokens}` });
      return { messages: msgs, needsRestart: false };
    }

    onEvent({ type: "thinking", round, maxRounds: config.maxRounds });

    let response: ChatMessage;
    let usage: UsageInfo | undefined;

    try {
      // Use streaming to get real-time content updates
      const accum: { content: string; toolCalls: Map<number, { id: string; name: string; args: string }> } = {
        content: "",
        toolCalls: new Map(),
      };

      for await (const event of chatCompletionStream(msgs, tools, config)) {
        if (event.type === "content") {
          accum.content += event.content!;
          onEvent({ type: "assistant_text", content: event.content! });
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
          throw new Error(event.error);
        }
      }

      // Build the final message
      response = { role: "assistant", content: accum.content || null };
      const toolCallsArr = [...accum.toolCalls.values()].filter((tc) => tc.id);
      if (toolCallsArr.length > 0) {
        response.tool_calls = toolCallsArr.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        }));
      }

      if (usage) totalTokens += usage.totalTokens;
    } catch (e) {
      onEvent({ type: "error", message: `API error: ${(e as Error).message}` });
      return { messages: msgs, needsRestart: false };
    }

    msgs.push(response);

    if (response.tool_calls?.length) {
      const toolResults = await Promise.all(
        response.tool_calls.map(async (tc) => {
          const name = tc.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            onEvent({ type: "tool_error", id: tc.id, name, message: `Invalid JSON: ${tc.function.arguments.substring(0, 200)}` });
            return { tc, result: `Error: Invalid JSON arguments: ${tc.function.arguments.substring(0, 200)}` };
          }

          onEvent({ type: "tool_call", id: tc.id, name, args });

          const result = await executeTool(name, args, {
            sandbox: config.sandbox,
            approve: config.approve,
            dryRun: config.dryRun,
            autoCommit: config.autoCommit,
            cwd: Deno.cwd(),
            askUser: undefined, // No interactive ask_user in web mode
          });

          const isError = result.output.startsWith("Error");
          onEvent({
            type: "tool_result",
            id: tc.id,
            name,
            result: result.output,
            error: isError,
            diff: result.diff,
          });

          return { tc, result: result.output };
        }),
      );

      for (const { tc, result } of toolResults) {
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
        if (result === "RESTART_READY") {
          const resumeFile = `${Deno.cwd()}/.ca_resume.json`;
          await saveConversation(msgs, resumeFile);
          onEvent({ type: "restart" });
          return { messages: msgs, needsRestart: true };
        }
      }

      if (config.dryRun) {
        onEvent({ type: "done", rounds: round, usage });
        return { messages: msgs, needsRestart: false };
      }
    } else {
      if (response.content) {
        // Final content already streamed; just send done
      }
      onEvent({ type: "done", rounds: round, usage });
      return { messages: msgs, needsRestart: false };
    }
  }

  onEvent({ type: "warning", message: `Reached max rounds (${config.maxRounds})` });
  return { messages: msgs, needsRestart: false };
}

// ─── CSS ─────────────────────────────────────────────────

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; height: 100vh; overflow: hidden; }
#app { display: flex; height: 100vh; }
#sidebar { width: 280px; background: #161b22; border-right: 1px solid #30363d; display: flex; flex-direction: column; font-size: 13px; }
#sb-header { padding: 14px 16px; font-weight: 700; font-size: 15px; color: #58a6ff; border-bottom: 1px solid #30363d; }
#sb-context { padding: 12px 16px; color: #8b949e; white-space: pre-wrap; overflow-y: auto; flex: 1; font-size: 12px; line-height: 1.5; }
#sb-stats { padding: 12px 16px; border-top: 1px solid #30363d; color: #8b949e; font-size: 12px; }
#main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#messages { flex: 1; overflow-y: auto; padding: 16px 20px; }
#input-area { display: flex; padding: 12px 16px; border-top: 1px solid #30363d; gap: 10px; background: #161b22; }
#input { flex: 1; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; font-family: monospace; font-size: 14px; resize: none; outline: none; }
#input:focus { border-color: #58a6ff; }
#send-btn { padding: 8px 18px; background: #238636; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; white-space: nowrap; }
#send-btn:hover { background: #2ea043; }
#send-btn:disabled { background: #30363d; cursor: not-allowed; }

.msg { margin-bottom: 16px; animation: fadeIn 0.2s; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.msg-user .role { color: #7ee787; font-weight: 600; }
.msg-assistant .role { color: #58a6ff; font-weight: 600; }
.msg-system .role { color: #8b949e; font-weight: 600; }
.msg-content { margin-top: 4px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.msg-content code { background: #1c2128; padding: 2px 5px; border-radius: 3px; font-size: 13px; }
.msg-content pre { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; overflow-x: auto; margin: 8px 0; }
.msg-content pre code { background: none; padding: 0; }

.tool-block { margin: 6px 0 6px 12px; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; }
.tool-header { padding: 6px 10px; background: #1c2128; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; cursor: pointer; }
.tool-header .icon { font-size: 14px; }
.tool-header .name { color: #58a6ff; }
.tool-header .args { color: #8b949e; font-weight: 400; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-result { padding: 6px 10px; font-size: 12px; line-height: 1.4; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
.tool-result.error { color: #f85149; background: #1a1115; }
.tool-result.success { color: #8b949e; }
.tool-diff { padding: 6px 10px; font-size: 12px; white-space: pre-wrap; font-family: monospace; max-height: 200px; overflow-y: auto; }
.tool-diff .add { color: #7ee787; }
.tool-diff .del { color: #f85149; }
.tool-diff .ctx { color: #8b949e; }

.thinking { display: flex; align-items: center; gap: 8px; color: #8b949e; font-size: 12px; padding: 8px 0; }
.spinner { width: 14px; height: 14px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.warning { color: #d2991d; font-size: 12px; padding: 4px 0; }
.error-msg { color: #f85149; font-size: 12px; padding: 4px 0; }

#status { position: fixed; bottom: 8px; right: 16px; font-size: 11px; color: #484f58; }
`;

// ─── JavaScript Client ──────────────────────────────────

const JS = `
const ws = new WebSocket(\`ws://\${location.host}/ws\`);
let currentAssistant = null;
let currentToolBlocks = new Map();
let streaming = false;

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "init" }));
};

ws.onmessage = (e) => {
  const event = JSON.parse(e.data);
  handleEvent(event);
};

ws.onclose = () => {
  document.getElementById("status").textContent = "disconnected — reload to reconnect";
};

ws.onerror = () => {
  document.getElementById("status").textContent = "connection error";
};

function handleEvent(ev) {
  switch (ev.type) {
    case "banner":
      document.getElementById("sb-header").textContent = \`CA \${ev.model}\`;
      document.getElementById("status").textContent = ev.model + " · " + ev.base;
      break;

    case "context":
      document.getElementById("sb-context").textContent = ev.content;
      break;

    case "thinking":
      streaming = true;
      setSendEnabled(false);
      addThinking(ev.round, ev.maxRounds);
      break;

    case "token_warning":
      addWarning(\`Token budget: ~\${ev.used} / \${ev.max} (\${ev.pct}%)\`);
      break;

    case "assistant_text":
      if (!currentAssistant) {
        removeThinking();
        currentAssistant = addMessage("assistant", "");
      }
      appendToMsg(currentAssistant, ev.content);
      break;

    case "tool_call":
      removeThinking();
      ensureAssistant();
      addToolCall(ev.id, ev.name, ev.args);
      break;

    case "tool_result":
      updateToolResult(ev.id, ev.name, ev.result, ev.error, ev.diff);
      break;

    case "tool_error":
      addToolError(ev.id, ev.name, ev.message);
      break;

    case "warning":
      addWarning(ev.message);
      break;

    case "error":
      addError(ev.message);
      streaming = false;
      setSendEnabled(true);
      break;

    case "done":
      removeThinking();
      finishAssistant(ev.rounds, ev.usage);
      streaming = false;
      setSendEnabled(true);
      break;

    case "restart":
      addWarning("CA is restarting with a new version…");
      streaming = false;
      setSendEnabled(true);
      break;

    case "aborted":
      addWarning("Operation aborted.");
      streaming = false;
      setSendEnabled(true);
      break;
  }
  scrollDown();
}

function ensureAssistant() {
  if (!currentAssistant) {
    currentAssistant = addMessage("assistant", "");
  }
}

function finishAssistant(rounds, usage) {
  currentAssistant = null;
  currentToolBlocks = new Map();
  if (usage) {
    document.getElementById("sb-stats").textContent =
      \`Tokens: \${usage.totalTokens} (in: \${usage.promptTokens} out: \${usage.completionTokens})\`;
  }
}

function setSendEnabled(v) {
  document.getElementById("send-btn").disabled = !v;
  document.getElementById("input").disabled = !v;
}

function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = "msg msg-" + role;
  const roleLabel = role === "user" ? "❯ you" : role === "assistant" ? "CA" : role;
  div.innerHTML = \`<div class="role">\${roleLabel}</div><div class="msg-content">\${escapeHtml(content)}</div>\`;
  document.getElementById("messages").appendChild(div);
  return div;
}

function appendToMsg(div, text) {
  const content = div.querySelector(".msg-content");
  content.textContent += text;
  // Basic markdown-like code rendering
  content.innerHTML = renderMarkdown(content.textContent);
}

function addToolCall(id, name, args) {
  ensureAssistant();
  const block = document.createElement("div");
  block.className = "tool-block";
  block.id = "tool-" + id;
  const icons = { read_file: "📖", write_file: "✏️", run_command: "⚡", search_files: "🔍", list_directory: "📁", ask_user: "💬", apply_diff: "📝", restart_self: "🔄" };
  const icon = icons[name] || "🔧";
  const argsStr = JSON.stringify(args, null, 0).substring(0, 120);
  block.innerHTML = \`<div class="tool-header"><span class="icon">\${icon}</span><span class="name">\${name}</span><span class="args">\${escapeHtml(argsStr)}</span></div><div class="tool-result" style="display:none"></div>\`;
  currentAssistant.appendChild(block);
  currentToolBlocks.set(id, { block, name });
}

function updateToolResult(id, name, result, isError, diff) {
  const tb = currentToolBlocks.get(id);
  if (!tb) return;
  const resDiv = tb.block.querySelector(".tool-result");
  resDiv.style.display = "block";
  resDiv.className = "tool-result " + (isError ? "error" : "success");
  resDiv.textContent = result.length > 2000 ? result.substring(0, 2000) + "…" : result;

  if (diff) {
    const diffDiv = document.createElement("div");
    diffDiv.className = "tool-diff";
    diffDiv.innerHTML = renderDiff(diff);
    tb.block.appendChild(diffDiv);
  }
}

function addToolError(id, name, msg) {
  const tb = currentToolBlocks.get(id);
  if (!tb) return;
  const resDiv = tb.block.querySelector(".tool-result");
  resDiv.style.display = "block";
  resDiv.className = "tool-result error";
  resDiv.textContent = msg;
}

function renderDiff(text) {
  return text.split("\\n").map(line => {
    if (line.startsWith("+")) return \`<span class="add">\${escapeHtml(line)}</span>\`;
    if (line.startsWith("-")) return \`<span class="del">\${escapeHtml(line)}</span>\`;
    return \`<span class="ctx">\${escapeHtml(line)}</span>\`;
  }).join("\\n");
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  // Code blocks
  html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
  // Inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  return html;
}

function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function addThinking(round, max) {
  removeThinking();
  const div = document.createElement("div");
  div.className = "thinking";
  div.id = "thinking";
  div.innerHTML = \`<div class="spinner"></div> Round \${round}/\${max} — thinking…\`;
  document.getElementById("messages").appendChild(div);
}

function removeThinking() {
  const el = document.getElementById("thinking");
  if (el) el.remove();
}

function addWarning(msg) {
  const div = document.createElement("div");
  div.className = "warning";
  div.textContent = "⚠ " + msg;
  document.getElementById("messages").appendChild(div);
}

function addError(msg) {
  const div = document.createElement("div");
  div.className = "error-msg";
  div.textContent = "✘ " + msg;
  document.getElementById("messages").appendChild(div);
}

function scrollDown() {
  const msgs = document.getElementById("messages");
  msgs.scrollTop = msgs.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById("input");
  const text = input.value.trim();
  if (!text || streaming) return;
  input.value = "";
  addMessage("user", text);
  ws.send(JSON.stringify({ type: "user_message", content: text }));
}

document.getElementById("send-btn").addEventListener("click", sendMessage);
document.getElementById("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMessage();
  }
});

// Initial status
document.getElementById("status").textContent = "connecting…";
`;

// ─── HTTP + WebSocket Server ───────────────────────────

export async function startWebServer(config: AgentConfig, port: number): Promise<void> {
  // Build context for the sidebar
  let contextStr = "";
  try {
    const { getProjectContext } = await import("./ca_agent.ts");
    contextStr = await getProjectContext(Deno.cwd());
  } catch { /* ok */ }

  const flags: string[] = [];
  if (config.thinking) flags.push("thinking");
  if (config.sandbox) flags.push("sandbox");
  if (config.approve) flags.push("approve");
  if (config.dryRun) flags.push("dry-run");
  if (config.stream) flags.push("stream");

  // Global state per session
  let messages: ChatMessage[] = [];
  let systemContent = "";

  async function initSession(): Promise<void> {
    systemContent = await buildSystemContent(config, Deno.cwd());
    messages = [{ role: "system", content: systemContent }];
  }

  await initSession();

  Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const { socket, response } = Deno.upgradeWebSocket(req);

      socket.onopen = () => {
        // Send banner and context
        socket.send(JSON.stringify({
          type: "banner",
          model: config.model,
          base: config.apiBase,
          flags,
        }));
        socket.send(JSON.stringify({
          type: "context",
          content: contextStr || `Working directory: ${Deno.cwd()}`,
        }));
      };

      socket.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data.type === "user_message") {
            const prompt = data.content as string;
            if (!prompt?.trim()) return;

            const result = await runWebAgent(prompt, messages, {
              config,
              onEvent: (ev) => {
                socket.send(JSON.stringify(ev));
              },
            });
            messages = result.messages;

            if (result.needsRestart) {
              // Wait a moment then restart
              setTimeout(async () => {
                // Re-init for new process
                await initSession();
              }, 500);
            }
          }
        } catch (e) {
          socket.send(JSON.stringify({
            type: "error",
            message: `Internal error: ${(e as Error).message}`,
          }));
        }
      };

      socket.onclose = () => {
        // Session cleanup — keep messages for potential reconnect
      };

      socket.onerror = (e) => {
        console.error("WebSocket error:", e);
      };

      return response;
    }

    // Serve the HTML page
    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  // The Deno.serve call above blocks, but we need to log the URL first
  // Deno.serve returns after the first request, so we do a trick:
  console.error(`\n  ${colorize("🌐", "\x1b[36m")} Web UI: http://localhost:${port}\n`);
}

function colorize(text: string, color: string): string {
  if (!Deno.stderr.isTerminal()) return text;
  return `${color}${text}\x1b[0m`;
}
