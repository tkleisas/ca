import type { ChatMessage, AgentConfig, UsageInfo } from "./ca_types.ts";
import { VERSION } from "./ca_types.ts";
import { buildToolDefs, executeTool } from "./ca_tools.ts";
import { chatCompletionStream, estimateMessagesTokens } from "./ca_client.ts";
import { buildSystemContent, saveConversation } from "./ca_agent.ts";
import { colorize } from "./ca_ui.ts";
import { isPathSafe } from "./ca_sandbox.ts";

// ─── Web UI Event Types ─────────────────────────────────

export type WebEvent =
  | { type: "banner"; model: string; base: string; flags: string[] }
  | { type: "context"; content: string }
  | { type: "thinking"; round: number; maxRounds: number }
  | { type: "token_warning"; used: number; max: number; pct: string }
  | { type: "token_update"; used: number; max: number; pct: string }
  | { type: "assistant_text"; content: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; result: string; error: boolean; diff?: string }
  | { type: "tool_error"; id: string; name: string; message: string }
  | { type: "warning"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; rounds: number; usage?: UsageInfo }
  | { type: "restart" }
  | { type: "aborted" }
  // File browser events
  | { type: "dir_listing"; path: string; entries: DirEntry[] }
  | { type: "file_content"; path: string; content: string; isMarkdown: boolean; isBinary: boolean; language: string };

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

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
    onEvent({
      type: "token_update",
      used: estTokens,
      max: config.maxTokens,
      pct: ((estTokens / config.maxTokens) * 100).toFixed(1),
    });
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
      const accum: { content: string; reasoning: string; toolCalls: Map<number, { id: string; name: string; args: string }> } = {
        content: "",
        reasoning: "",
        toolCalls: new Map(),
      };

      for await (const event of chatCompletionStream(msgs, tools, config)) {
        if (event.type === "reasoning") {
          accum.reasoning += event.content!;
        } else if (event.type === "content") {
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
      if (accum.reasoning) response.reasoning_content = accum.reasoning;
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
.msg-content .code-block-wrap { position: relative; margin: 8px 0; }
.msg-content .copy-btn { position: absolute; top: 6px; right: 8px; background: #21262d; color: #8b949e; border: 1px solid #30363d; border-radius: 4px; padding: 2px 7px; font-size: 11px; cursor: pointer; opacity: 0; transition: opacity 0.15s; }
.msg-content .code-block-wrap:hover .copy-btn { opacity: 1; }
.msg-content .copy-btn:hover { background: #30363d; color: #c9d1d9; }
.msg-content .copy-btn.copied { background: #1a3d2e; border-color: #238636; color: #7ee787; }

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

/* Sidebar tabs */
#sb-tabs { display: flex; border-bottom: 1px solid #30363d; }
.sb-tab { flex: 1; padding: 8px 0; background: none; border: none; color: #8b949e; cursor: pointer; font-size: 12px; font-weight: 600; border-bottom: 2px solid transparent; transition: all 0.15s; }
.sb-tab:hover { color: #c9d1d9; }
.sb-tab.active { color: #58a6ff; border-bottom-color: #58a6ff; }
.sb-panel { flex: 1; overflow-y: auto; }

/* File browser */
#fb-filter-wrap { padding: 6px 8px; border-bottom: 1px solid #21262d; }
#fb-filter { width: 100%; background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 4px; padding: 5px 8px; font-size: 11px; font-family: monospace; outline: none; }
#fb-filter:focus { border-color: #58a6ff; }
#fb-filter::placeholder { color: #484f58; }
#file-browser { padding: 0; font-size: 12px; user-select: none; }
.fb-path { padding: 8px 12px; color: #8b949e; font-size: 11px; border-bottom: 1px solid #21262d; cursor: pointer; display: flex; align-items: center; gap: 4px; }
.fb-path:hover { color: #c9d1d9; }
.fb-entry { display: flex; align-items: center; padding: 3px 12px; cursor: pointer; color: #c9d1d9; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fb-entry:hover { background: #1c2128; }
.fb-entry.dir { color: #58a6ff; font-weight: 500; }
.fb-entry .fb-icon { font-size: 13px; flex-shrink: 0; width: 16px; text-align: center; }
.fb-entry .fb-size { margin-left: auto; color: #484f58; font-size: 10px; flex-shrink: 0; }
.fb-empty { padding: 16px 12px; color: #484f58; font-style: italic; font-size: 12px; }

/* File viewer */
#viewer-overlay { position: fixed; top: 0; right: 0; bottom: 0; width: 50%; min-width: 400px; background: #161b22; border-left: 1px solid #30363d; z-index: 100; display: flex; flex-direction: column; box-shadow: -4px 0 24px rgba(0,0,0,0.5); }
#viewer { display: flex; flex-direction: column; height: 100%; }
#viewer-header { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid #30363d; background: #0d1117; gap: 10px; }
#viewer-title { flex: 1; font-size: 13px; font-weight: 600; color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#viewer-close { background: none; border: none; color: #8b949e; cursor: pointer; font-size: 18px; padding: 2px 6px; border-radius: 4px; }
#viewer-close:hover { background: #30363d; color: #c9d1d9; }
#viewer-content { flex: 1; overflow-y: auto; padding: 16px; font-size: 13px; line-height: 1.6; }
#viewer-content pre { margin: 0; padding: 12px; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.5; }
#viewer-content code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 12px; }
#viewer-content .viewer-binary { text-align: center; padding: 40px 20px; color: #8b949e; }
#viewer-content .viewer-binary .icon { font-size: 48px; display: block; margin-bottom: 12px; }

/* Markdown rendered in viewer */
.md-rendered { line-height: 1.7; }
.md-rendered h1 { font-size: 1.8em; border-bottom: 1px solid #30363d; padding-bottom: 8px; margin: 20px 0 12px; color: #f0f6fc; }
.md-rendered h2 { font-size: 1.4em; border-bottom: 1px solid #30363d; padding-bottom: 6px; margin: 18px 0 10px; color: #f0f6fc; }
.md-rendered h3 { font-size: 1.2em; margin: 16px 0 8px; color: #f0f6fc; }
.md-rendered h4, .md-rendered h5, .md-rendered h6 { font-size: 1.05em; margin: 14px 0 6px; color: #f0f6fc; }
.md-rendered p { margin: 8px 0; }
.md-rendered a { color: #58a6ff; text-decoration: none; }
.md-rendered a:hover { text-decoration: underline; }
.md-rendered ul, .md-rendered ol { padding-left: 24px; margin: 8px 0; }
.md-rendered li { margin: 3px 0; }
.md-rendered blockquote { border-left: 3px solid #30363d; padding: 4px 12px; margin: 10px 0; color: #8b949e; background: #0d1117; border-radius: 0 4px 4px 0; }
.md-rendered code { background: #1c2128; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
.md-rendered pre { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; overflow-x: auto; margin: 10px 0; }
.md-rendered pre code { background: none; padding: 0; font-size: 12px; }
.md-rendered hr { border: none; border-top: 1px solid #30363d; margin: 16px 0; }
.md-rendered strong { color: #f0f6fc; }
.md-rendered table { border-collapse: collapse; width: 100%; margin: 10px 0; }
.md-rendered th, .md-rendered td { border: 1px solid #30363d; padding: 6px 12px; text-align: left; }
.md-rendered th { background: #0d1117; font-weight: 600; }
.md-rendered img { max-width: 100%; border-radius: 4px; }

@media (max-width: 800px) {
  #viewer-overlay { width: 100%; min-width: unset; }
}
`;

// ─── JavaScript Client ──────────────────────────────────

const JS = `
const ws = new WebSocket(\`ws://\${location.host}/ws\`);
let currentAssistant = null;
let currentToolBlocks = new Map();
let streaming = false;
let currentBrowsePath = null;

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "init" }));
  // Load initial file listing
  ws.send(JSON.stringify({ type: "list_dir" }));
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

    case "dir_listing":
      currentBrowsePath = ev.path;
      renderFileBrowser(ev.path, ev.entries);
      break;

    case "file_content":
      showFileViewer(ev.path, ev.content, ev.isMarkdown, ev.isBinary, ev.language);
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

// ─── Tab switching ──────────────────────────────────────

document.getElementById("tab-context").addEventListener("click", () => switchTab("context"));
document.getElementById("tab-files").addEventListener("click", () => switchTab("files"));

function switchTab(tab) {
  document.getElementById("tab-context").classList.toggle("active", tab === "context");
  document.getElementById("tab-files").classList.toggle("active", tab === "files");
  document.getElementById("sb-panel-context").style.display = tab === "context" ? "" : "none";
  document.getElementById("sb-panel-files").style.display = tab === "files" ? "" : "none";
  if (tab === "files" && !currentBrowsePath) {
    ws.send(JSON.stringify({ type: "list_dir" }));
  }
}

// ─── File Browser ───────────────────────────────────────

let currentEntries = [];
let currentBrowseFullPath = "";

document.getElementById("fb-filter").addEventListener("input", (e) => {
  const filter = e.target.value.toLowerCase();
  if (currentEntries.length > 0) {
    const filtered = filter
      ? currentEntries.filter(entry => entry.name.toLowerCase().includes(filter))
      : currentEntries;
    renderFileBrowserEntries(currentBrowseFullPath, filtered);
  }
});

const FILE_ICONS = {
  ts: "🟦", tsx: "⚛️", js: "🟨", jsx: "⚛️", json: "📋",
  md: "📝", markdown: "📝",
  py: "🐍", rs: "🦀", go: "🔵", java: "☕", rb: "💎",
  html: "🌐", htm: "🌐", css: "🎨", scss: "🎨",
  svg: "🖼️", png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️", ico: "🖼️",
  sh: "💻", bash: "💻", zsh: "💻", fish: "💻",
  toml: "⚙️", yaml: "⚙️", yml: "⚙️", ini: "⚙️", cfg: "⚙️", env: "⚙️",
  pdf: "📕", zip: "📦", tar: "📦", gz: "📦",
  sql: "🗄️", db: "🗄️", sqlite: "🗄️",
  lock: "🔒", gitignore: "🙈",
};

function getFileIcon(name, isDir) {
  if (isDir) return "📁";
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return FILE_ICONS[ext] || (name.startsWith(".") ? "⚪" : "📄");
}

function formatFileSize(bytes) {
  if (bytes === 0) return "";
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "K";
  return (bytes / (1024 * 1024)).toFixed(1) + "M";
}

function renderFileBrowser(path, entries) {
  currentEntries = entries;
  currentBrowseFullPath = path;
  // Clear filter when navigating
  document.getElementById("fb-filter").value = "";
  renderFileBrowserEntries(path, entries);
}

function renderFileBrowserEntries(path, entries) {
  const fb = document.getElementById("file-browser");
  let html = '';

  // Breadcrumb/path header — clickable segments
  const parts = path === "." ? [] : path.replace(/^\\.\\//, "").split("/");
  html += '<div class="fb-path">';
  html += \`<span onclick="navigateTo('')" style="color:#58a6ff;cursor:pointer">📁 .</span>\`;
  let accum = "";
  for (const part of parts) {
    accum += (accum ? "/" : "") + part;
    html += \` <span style="color:#484f58">/</span> <span onclick="navigateTo('\${accum}')" style="color:#58a6ff;cursor:pointer">\${escapeHtml(part)}</span>\`;
  }
  html += '</div>';

  // Up directory
  if (path && path !== ".") {
    const parent = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";
    html += \`<div class="fb-entry dir" onclick="navigateTo('\${parent}')"><span class="fb-icon">📂</span>..</div>\`;
  }

  if (entries.length === 0) {
    const filterVal = document.getElementById("fb-filter").value;
    html += filterVal
      ? \`<div class="fb-empty">no files matching "\${escapeHtml(filterVal)}"</div>\`
      : '<div class="fb-empty">(empty directory)</div>';
  } else {
    for (const entry of entries) {
      const icon = getFileIcon(entry.name, entry.isDirectory);
      const cls = entry.isDirectory ? "dir" : "";
      const entryPath = (path === "." ? "" : path + "/") + entry.name;
      const sizeStr = entry.isDirectory ? "" : \`<span class="fb-size">\${formatFileSize(entry.size)}</span>\`;
      const onClick = entry.isDirectory
        ? \`onclick="navigateTo('\${entryPath}')"\`
        : \`onclick="openFile('\${entryPath}')"\`;
      html += \`<div class="fb-entry \${cls}" \${onClick}><span class="fb-icon">\${icon}</span>\${escapeHtml(entry.name)}\${sizeStr}</div>\`;
    }
  }

  fb.innerHTML = html;
}

function navigateTo(path) {
  ws.send(JSON.stringify({ type: "list_dir", path: path }));
}

function openFile(path) {
  ws.send(JSON.stringify({ type: "read_file", path: path }));
}

// ─── File Viewer ────────────────────────────────────────

let viewerPath = null;

function showFileViewer(path, content, isMarkdown, isBinary, language) {
  viewerPath = path;
  const overlay = document.getElementById("viewer-overlay");
  const title = document.getElementById("viewer-title");
  const contentDiv = document.getElementById("viewer-content");

  // Show filename in title
  const name = path.includes("/") ? path.substring(path.lastIndexOf("/") + 1) : path;
  title.textContent = "📄 " + name;

  if (isBinary) {
    contentDiv.className = "";
    contentDiv.innerHTML = '<div class="viewer-binary"><span class="icon">📦</span>Binary file — cannot preview</div>';
  } else if (isMarkdown) {
    contentDiv.className = "md-rendered";
    contentDiv.innerHTML = renderFullMarkdown(content);
  } else {
    contentDiv.className = "";
    const langClass = language ? \` class="language-\${language}"\` : "";
    contentDiv.innerHTML = \`<pre><code\${langClass}>\${escapeHtml(content)}</code></pre>\`;
  }

  overlay.style.display = "";
}

document.getElementById("viewer-close").addEventListener("click", () => {
  document.getElementById("viewer-overlay").style.display = "none";
  viewerPath = null;
});

// Close viewer with Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("viewer-overlay").style.display !== "none") {
    document.getElementById("viewer-overlay").style.display = "none";
    viewerPath = null;
  }
});

// ─── Full Markdown Renderer ─────────────────────────────

function renderFullMarkdown(text) {
  let html = escapeHtml(text);

  // Code blocks (fenced) — with copy button
  html = html.replace(/\`\`\`(\\w*)\\n?([\\s\\S]*?)\`\`\`/g, function(m, lang, code) {
    const lc = escapeHtml(lang || "").trim();
    const cls = lc ? \` class="language-\${lc}"\` : "";
    const id = "cbv-" + Math.random().toString(36).substring(2, 8);
    return \`<div class="code-block-wrap"><button class="copy-btn" onclick="copyCode('\${id}')">Copy</button><pre id="\${id}"><code\${cls}>\${escapeHtml(code)}</code></pre></div>\`;
  });

  // Inline code
  html = html.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');

  // Headings
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^(---|\\*\\*\\*|___)\\s*$/gm, '<hr>');

  // Bold and italic
  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links
  html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');

  // Images
  html = html.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img src="$2" alt="$1">');

  // Unordered lists
  html = html.replace(/^(\\s*)[-\\*] (.+)$/gm, function(m, indent, content) {
    return indent + '<li>' + content + '</li>';
  });

  // Ordered lists
  html = html.replace(/^(\\s*)\\d+\\. (.+)$/gm, function(m, indent, content) {
    return indent + '<li>' + content + '</li>';
  });

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, function(m, content) {
    return '<blockquote><p>' + content + '</p></blockquote>';
  });

  // Tables (simple: | a | b |)
  html = html.replace(/^\\|(.+)\\|$/gm, function(m) {
    const cells = m.split("|").filter(c => c.trim());
    const isHeader = m.match(/^\\|[\\s-:|]+\\|$/);
    if (isHeader) return "";
    const tag = "td";
    return '<tr>' + cells.map(c => \`<\${tag}>\${c.trim()}</\${tag}>\`).join("") + '</tr>';
  });

  // Paragraphs: wrap remaining text blocks
  // Split on double newlines and wrap in <p>
  const blocks = html.split(/\\n\\n+/);
  html = blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed) return "";
    // Don't wrap elements that are already block-level
    if (trimmed.match(/^<(h[1-6]|hr|pre|blockquote|table|ul|ol|li|tr|div)/)) return trimmed;
    return '<p>' + trimmed + '</p>';
  }).join("\\n");

  // Join loose <li> elements into <ul> blocks
  html = html.replace(/((?:<li>[\\s\\S]*?<\\/li>\\n?)+)/g, function(m) {
    return '<ul>\\n' + m + '\\n</ul>';
  });

  return html;
}

// ─── Existing helpers ───────────────────────────────────

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
  // Code blocks with copy button
  html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(m, code) {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Unique id for copy button
    const id = "cb-" + Math.random().toString(36).substring(2, 8);
    return \`<div class="code-block-wrap"><button class="copy-btn" onclick="copyCode('\${id}')">Copy</button><pre id="\${id}"><code>\${escaped}</code></pre></div>\`;
  });
  // Inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  return html;
}

function copyCode(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.textContent;
  navigator.clipboard.writeText(text).then(() => {
    // Find the button in the parent wrapper
    const btn = el.parentElement.querySelector(".copy-btn");
    if (btn) {
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 2000);
    }
  }).catch(() => { /* clipboard not available */ });
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

// ─── HTML Template ──────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CA ${VERSION} — Web UI</title>
<style>
${CSS}
</style>
</head>
<body>
<div id="app">
  <div id="sidebar">
    <div id="sb-header">CA ${VERSION}</div>
    <div id="sb-tabs">
      <button id="tab-context" class="sb-tab active">Context</button>
      <button id="tab-files" class="sb-tab">Files</button>
    </div>
    <div id="sb-panel-context" class="sb-panel">
      <div id="sb-context"></div>
    </div>
    <div id="sb-panel-files" class="sb-panel" style="display:none">
      <div id="fb-filter-wrap"><input id="fb-filter" type="text" placeholder="Filter files…"></div>
      <div id="file-browser"></div>
    </div>
    <div id="sb-stats"></div>
  </div>
  <div id="main">
    <div id="messages"></div>
    <div id="input-area">
      <textarea id="input" rows="2" placeholder="Send a message… (Ctrl+Enter to send)"></textarea>
      <button id="send-btn">Send</button>
    </div>
  </div>
  <div id="viewer-overlay" style="display:none">
    <div id="viewer">
      <div id="viewer-header">
        <span id="viewer-title"></span>
        <button id="viewer-close">✕</button>
      </div>
      <div id="viewer-content"></div>
    </div>
  </div>
</div>
<div id="status">connecting…</div>
<script>
${JS}
</script>
</body>
</html>`;

// ─── File Browser Helpers ───────────────────────────────

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "svg", "webp",
  "pdf", "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
  "exe", "dll", "so", "dylib", "wasm", "bin",
  "mp3", "mp4", "wav", "ogg", "avi", "mov", "webm",
  "ttf", "otf", "woff", "woff2", "eot",
  "db", "sqlite", "sqlite3",
]);

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mkdn"]);

const CODE_EXTENSIONS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", java: "java", c: "c",
  cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp", rb: "ruby",
  php: "php", swift: "swift", kt: "kotlin", scala: "scala",
  sh: "bash", bash: "bash", zsh: "bash", fish: "fish",
  sql: "sql", html: "html", css: "css", scss: "scss",
  json: "json", xml: "xml", yaml: "yaml", yml: "yaml",
  toml: "toml", ini: "ini", cfg: "ini", env: "sh",
  dockerfile: "dockerfile", makefile: "makefile",
  vue: "html", svelte: "html", astro: "html",
};

function getFileInfo(name: string): { isBinary: boolean; isMarkdown: boolean; language: string } {
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
  const base = name.toLowerCase();
  if (base === "dockerfile") return { isBinary: false, isMarkdown: false, language: "dockerfile" };
  if (base === "makefile") return { isBinary: false, isMarkdown: false, language: "makefile" };
  return {
    isBinary: BINARY_EXTENSIONS.has(ext),
    isMarkdown: MARKDOWN_EXTENSIONS.has(ext),
    language: CODE_EXTENSIONS[ext] ?? "",
  };
}

async function listDirEntries(dirPath: string): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (entry.name.startsWith(".") && entry.name !== ".ca.json") continue;
      let size = 0;
      if (entry.isFile) {
        try {
          const info = await Deno.stat(`${dirPath}/${entry.name}`);
          size = info.size;
        } catch { /* ignore stat errors */ }
      }
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory,
        size,
      });
    }
  } catch { /* permission error, return empty */ }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

async function readFileForWeb(filePath: string): Promise<{ content: string; isBinary: boolean; isMarkdown: boolean; language: string }> {
  const info = getFileInfo(filePath);
  if (info.isBinary) {
    return { content: "", isBinary: true, isMarkdown: false, language: "" };
  }
  try {
    const raw = await Deno.readTextFile(filePath);
    // Limit to 500KB
    const content = raw.length > 500_000 ? raw.substring(0, 500_000) + "\n...[truncated]" : raw;
    return { content, isBinary: false, isMarkdown: info.isMarkdown, language: info.language };
  } catch (e) {
    return { content: `Error reading file: ${(e as Error).message}`, isBinary: true, isMarkdown: false, language: "" };
  }
}

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

  console.error(`\n  ${colorize("🌐", "\x1b[36m")} Web UI: http://localhost:${port}\n`);

  try {
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
            } else if (data.type === "list_dir") {
              const reqPath = (data.path as string) || Deno.cwd();
              const safety = isPathSafe(reqPath, Deno.cwd(), config.sandbox);
              if (!safety.safe) {
                socket.send(JSON.stringify({ type: "error", message: `Path blocked: ${safety.reason}` }));
                return;
              }
              const entries = await listDirEntries(reqPath);
              // Resolve to a relative display path
              const cwd = Deno.cwd();
              const displayPath = reqPath === cwd ? "." : (reqPath.startsWith(cwd + "/") ? "./" + reqPath.substring(cwd.length + 1) : reqPath);
              socket.send(JSON.stringify({ type: "dir_listing", path: displayPath, entries }));
            } else if (data.type === "read_file") {
              const reqPath = data.path as string;
              if (!reqPath) {
                socket.send(JSON.stringify({ type: "error", message: "No path provided" }));
                return;
              }
              const safety = isPathSafe(reqPath, Deno.cwd(), config.sandbox);
              if (!safety.safe) {
                socket.send(JSON.stringify({ type: "error", message: `Path blocked: ${safety.reason}` }));
                return;
              }
              const fileInfo = await readFileForWeb(reqPath);
              socket.send(JSON.stringify({
                type: "file_content",
                path: reqPath,
                content: fileInfo.content,
                isMarkdown: fileInfo.isMarkdown,
                isBinary: fileInfo.isBinary,
                language: fileInfo.language,
              }));
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
  } catch (e) {
    console.error(`${colorize("✘", "\x1b[31m")} Web server failed: ${(e as Error).message}`);
    console.error(`  Falling back to interactive mode.`);
  }
}
