// ─── Version ──────────────────────────────────────────

export const VERSION = "0.2.2";

// ─── Core Message Types ──────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, ToolParamDef>;
      required: string[];
    };
  };
}

export interface ToolParamDef {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

// ─── Agent Configuration ─────────────────────────────

export interface AgentConfig {
  model: string;
  apiKey: string;
  apiBase: string;
  maxTokens: number;
  maxRounds: number;
  maxRetries: number;
  temperature: number;
  topP?: number;
  stop: string;
  responseFormat: string;
  logprobs: boolean;
  topLogprobs?: number;
  userId: string;
  thinking: boolean;
  reasoningEffort: string;
  stream: boolean;
  // Safety
  sandbox: boolean;
  approve: boolean;
  dryRun: boolean;
  autoCommit: boolean;
  // Tools enabled
  tools: EnabledTools;
  // System prompt
  systemPrompt?: string;
  systemPromptFile?: string;
  // Resume
  resumeFile?: string;
}

export interface EnabledTools {
  read_file: boolean;
  write_file: boolean;
  run_command: boolean;
  search_files: boolean;
  list_directory: boolean;
  ask_user: boolean;
  apply_diff: boolean;
  restart_self: boolean;
}

// ─── Project Config File ─────────────────────────────

export interface CaJsonConfig {
  model?: string;
  api_base?: string;
  api_key?: string;
  max_tokens?: number;
  max_rounds?: number;
  max_retries?: number;
  temperature?: number;
  top_p?: number;
  stop?: string;
  response_format?: string;
  logprobs?: boolean;
  top_logprobs?: number;
  user_id?: string;
  thinking?: boolean;
  reasoning_effort?: string;
  stream?: boolean;
  sandbox?: boolean;
  approve?: boolean;
  auto_commit?: boolean;
  tools?: Partial<EnabledTools>;
  system_prompt?: string;
}

// ─── Conversation Export ─────────────────────────────

export interface ConversationExport {
  version: string;
  timestamp: string;
  messages: ChatMessage[];
}

// ─── Tool Result ─────────────────────────────────────

export interface ToolExecResult {
  output: string;
  error: boolean;
  diff?: string;
}

// ─── Sandbox Check Result ────────────────────────────

export interface SafetyCheck {
  safe: boolean;
  reason?: string;
}

// ─── Usage Info ──────────────────────────────────────

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Diff Hunk ────────────────────────────────────────

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  content: string;
  oldLine?: number;
  newLine?: number;
}
