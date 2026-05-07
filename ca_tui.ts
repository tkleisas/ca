// ─── CA TUI Module ──────────────────────────────────────
// Full-screen terminal UI for interactive mode.
// Layout:
//   ┌─ Conversation (scrollable) ───────────────────┐
//   │  user: message...                             │
//   │  ca: response text...                         │
//   │  ┌─ 🔧 tool ──────────────────────────────┐   │
//   │  │  ✓ result preview (0.3s)               │   │
//   │  └────────────────────────────────────────┘   │
//   ├─ Status ──────────────────────────────────────┤
//   │  model │ ~12K/1M ctx │ /home/.../ca │ master  │
//   ├─ Input (Ctrl+Enter to send, Esc+Esc to exit)──┤
//   │  > █                                         │
//   └───────────────────────────────────────────────┘

import type { ChatMessage, AgentConfig, UsageInfo } from "./ca_types.ts";
import type { ToolCall } from "./ca_types.ts";
import { buildToolDefs, executeTool } from "./ca_tools.ts";
import { chatCompletionStream, estimateMessagesTokens } from "./ca_client.ts";
import { buildSystemContent } from "./ca_agent.ts";

// ─── TUI Event Types ──────────────────────────────────

export interface TuiEvent {
  type: "text" | "tool_call" | "tool_result" | "tool_error" | "done" | "warning" | "error" | "aborted";
  content?: string;
  round?: number;
  toolId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolError?: boolean;
  diff?: string;
  usage?: UsageInfo;
  message?: string;
}

export interface TuiRunResult {
  messages: ChatMessage[];
  needsRestart: boolean;
}

// ─── Streaming Agent Runner (for TUI) ─────────────────

export async function* runAgentStream(
  prompt: string,
  messages: ChatMessage[],
  config: AgentConfig,
  signal?: AbortSignal,
): AsyncGenerator<TuiEvent, TuiRunResult, void> {
  const tools = buildToolDefs(config);
  const systemContent = await buildSystemContent(config, Deno.cwd());

  const msgs = structuredClone(messages);
  if (msgs.length > 0 && msgs[0].role === "system") {
    msgs[0].content = systemContent;
  } else if (msgs.length === 0 || msgs[0].role !== "system") {
    msgs.unshift({ role: "system", content: systemContent });
  }

  msgs.push({ role: "user", content: prompt });

  for (let round = 1; round <= config.maxRounds; round++) {
    if (signal?.aborted) {
      yield { type: "aborted" };
      return { messages: msgs, needsRestart: false };
    }

    const estTokens = estimateMessagesTokens(msgs);
    if (estTokens > config.maxTokens * 0.9) {
      yield { type: "warning", message: `Token budget near limit: ~${estTokens}/${config.maxTokens}` };
    }
    if (estTokens > config.maxTokens) {
      yield { type: "error", message: `Token budget exceeded: ~${estTokens} > ${config.maxTokens}` };
      return { messages: msgs, needsRestart: false };
    }

    let response: ChatMessage;
    let usage: UsageInfo | undefined;

    // Build response from streaming
    const accum: {
      content: string;
      reasoning: string;
      toolCalls: Map<number, { id: string; name: string; args: string }>;
    } = { content: "", reasoning: "", toolCalls: new Map() };

    try {
      for await (const event of chatCompletionStream(msgs, tools, config)) {
        if (signal?.aborted) {
          yield { type: "aborted" };
          return { messages: msgs, needsRestart: false };
        }

        if (event.type === "reasoning") {
          accum.reasoning += event.content!;
        } else if (event.type === "content") {
          accum.content += event.content!;
          yield { type: "text", content: event.content!, round };
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
          yield { type: "error", message: `API error: ${event.error}` };
          return { messages: msgs, needsRestart: false };
        }
      }
    } catch (e) {
      yield { type: "error", message: `API error: ${(e as Error).message}` };
      return { messages: msgs, needsRestart: false };
    }

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

    msgs.push(response);

    // Execute tools
    if (response.tool_calls?.length) {
      const toolResults = await Promise.all(
        response.tool_calls.map(async (tc) => {
          const name = tc.function.name;
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments); } catch {
            yield { type: "tool_error", toolId: tc.id, toolName: name, message: "Invalid JSON arguments" };
            return { tc, result: `Error: Invalid JSON` };
          }

          yield { type: "tool_call", toolId: tc.id, toolName: name, toolArgs: args, round };

          const result = await executeTool(name, args, {
            sandbox: config.sandbox,
            approve: config.approve,
            dryRun: config.dryRun,
            autoCommit: config.autoCommit,
            cwd: Deno.cwd(),
            askUser: undefined,
          });

          const isError = result.output.startsWith("Error");
          yield { type: "tool_result", toolId: tc.id, toolName: name, toolResult: result.output, toolError: isError, diff: result.diff, round };
          return { tc, result: result.output };
        }),
      );

      for (const { tc, result } of toolResults) {
        msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
        if (result === "RESTART_READY") {
          yield { type: "done", usage };
          return { messages: msgs, needsRestart: true };
        }
      }

      if (config.dryRun) {
        yield { type: "done", usage };
        return { messages: msgs, needsRestart: false };
      }
    } else {
      yield { type: "done", usage };
      return { messages: msgs, needsRestart: false };
    }
  }

  yield { type: "warning", message: `Reached max rounds (${config.maxRounds})` };
  return { messages: msgs, needsRestart: false };
}
