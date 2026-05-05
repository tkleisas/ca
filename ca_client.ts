import type { ChatMessage, ToolDef, UsageInfo } from "./ca_types.ts";
import type { AgentConfig } from "./ca_types.ts";
import { colorize, dim } from "./ca_ui.ts";

// ─── Shared API Helpers ────────────────────────────────

function buildApiHeaders(config: AgentConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
  return headers;
}

function parseUsage(data: Record<string, unknown>): UsageInfo | undefined {
  const u = data.usage as Record<string, number> | undefined;
  if (!u) return undefined;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    totalTokens: u.total_tokens,
  };
}

async function retryDelay(attempt: number, maxRetries: number): Promise<void> {
  const delay = 1000 * (attempt + 1);
  console.error(`${colorize("⚠", dim(""))} Retrying in ${delay}ms...`);
  await new Promise((r) => setTimeout(r, delay));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function handleRetryableError(response: Response, attempt: number, maxRetries: number): Promise<boolean> {
  if (isRetryableStatus(response.status) && attempt < maxRetries - 1) {
    const delay = response.status === 429 ? 2000 * (attempt + 1) : 1000 * (attempt + 1);
    await new Promise((r) => setTimeout(r, delay));
    return true; // retry
  }
  return false;
}

function isRetryableError(error: unknown): boolean {
  // Network errors (TypeError from fetch), connection refused, etc.
  if (error instanceof TypeError) return true;
  // Deno-specific network errors
  const msg = String(error);
  return msg.includes("connection") || msg.includes("network") || msg.includes("timeout") || msg.includes("abort");
}

// ─── Non-Streaming Completion ─────────────────────────

export interface CompletionResult {
  message: ChatMessage;
  usage?: UsageInfo;
}

export async function chatCompletion(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: AgentConfig,
): Promise<CompletionResult> {
  const url = `${config.apiBase}/chat/completions`;
  const body = buildRequestBody(messages, tools, config);
  const headers = buildApiHeaders(config);
  const maxRetries = config.maxRetries;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        if (await handleRetryableError(response, attempt, maxRetries)) continue;
        throw new Error(`API ${response.status}: ${text.substring(0, 500)}`);
      }

      const data = await response.json();
      const message = data.choices[0].message as ChatMessage;
      return { message, usage: parseUsage(data) };
    } catch (e) {
      if (attempt === maxRetries - 1 || !isRetryableError(e)) throw e;
      await retryDelay(attempt, maxRetries);
    }
  }
  throw new Error("Unreachable");
}

// ─── Streaming Completion ─────────────────────────────

export interface StreamEvent {
  type: "content" | "tool_call_start" | "tool_call_delta" | "done" | "error";
  content?: string;
  toolIndex?: number;
  toolId?: string;
  toolName?: string;
  toolArgs?: string;
  finishReason?: string;
  usage?: UsageInfo;
  error?: string;
}

export async function* chatCompletionStream(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: AgentConfig,
): AsyncGenerator<StreamEvent> {
  const url = `${config.apiBase}/chat/completions`;
  const body = {
    ...buildRequestBody(messages, tools, config),
    stream: true,
    stream_options: { include_usage: true },
  };
  const headers = buildApiHeaders(config);
  const maxRetries = config.maxRetries;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        if (await handleRateLimit(response, attempt, maxRetries)) continue;
        yield { type: "error", error: `API ${response.status}: ${text.substring(0, 500)}` };
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield { type: "error", error: "No response body reader" };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";

      // Track accumulated tool calls
      const toolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
      }> = [];
      let finishReason: string | null = null;
      let finalUsage: UsageInfo | undefined;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === "data: [DONE]") continue;
            if (!trimmed.startsWith("data: ")) continue;

            try {
              const json = JSON.parse(trimmed.substring(6));
              const choice = json.choices?.[0];
              if (!choice) {
                // Final chunk with usage
                if (json.usage) {
                  finalUsage = parseUsage(json);
                }
                continue;
              }

              const delta = choice.delta;
              if (!delta) continue;

              // Content delta
              if (delta.content) {
                yield { type: "content", content: delta.content };
              }

              // Tool call deltas
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;

                  // Initialize tool call if needed
                  while (toolCalls.length <= idx) {
                    toolCalls.push({ id: "", name: "", arguments: "" });
                  }

                  if (tc.id) {
                    toolCalls[idx].id = tc.id;
                    yield {
                      type: "tool_call_start",
                      toolIndex: idx,
                      toolId: tc.id,
                      toolName: tc.function?.name,
                    };
                  }
                  if (tc.function?.name) {
                    toolCalls[idx].name = tc.function.name;
                  }
                  if (tc.function?.arguments) {
                    toolCalls[idx].arguments += tc.function.arguments;
                    yield {
                      type: "tool_call_delta",
                      toolIndex: idx,
                      toolArgs: tc.function.arguments,
                    };
                  }
                }
              }

              finishReason = choice.finish_reason ?? finishReason;
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Build final message
      const finalMessage: ChatMessage = {
        role: "assistant",
        content: null,
      };

      if (toolCalls.length > 0) {
        finalMessage.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));
      }

      yield {
        type: "done",
        finishReason: finishReason ?? "stop",
        usage: finalUsage,
      };

      return;
    } catch (e) {
      if (attempt === maxRetries - 1) {
        yield { type: "error", error: (e as Error).message };
        return;
      }
      await retryDelay(attempt, maxRetries);
    }
  }
}

// ─── Build Request Body ───────────────────────────────

function buildRequestBody(
  messages: ChatMessage[],
  tools: ToolDef[],
  config: AgentConfig,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    tools,
  };

  if (config.topP !== undefined) {
    body.top_p = config.topP;
  }

  if (config.stop) {
    const stops = config.stop.split(",").map((s) => s.trim()).filter(Boolean);
    if (stops.length === 1) {
      body.stop = stops[0];
    } else if (stops.length > 1) {
      body.stop = stops;
    }
  }

  if (config.responseFormat === "json") {
    body.response_format = { type: "json_object" };
  }

  if (config.logprobs) {
    body.logprobs = true;
    if (config.topLogprobs !== undefined) {
      body.top_logprobs = config.topLogprobs;
    }
  }

  if (config.userId) {
    body.user_id = config.userId;
  }

  if (config.thinking) {
    body.thinking = { type: "enabled" };
  }

  if (config.reasoningEffort) {
    body.reasoning_effort = config.reasoningEffort;
  }

  return body;
}

// ─── Token Estimation ──────────────────────────────────

/**
 * Rough token estimation: ~3.5 characters per token.
 * This is a conservative estimate; actual tokens vary by model.
 * Claude: ~3.5 chars/token, GPT-4: ~4 chars/token, DeepSeek: ~3 chars/token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content ?? "");
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.name);
        total += estimateTokens(tc.function.arguments);
      }
    }
    // Role and structure overhead
    total += 4;
  }
  return total;
}
