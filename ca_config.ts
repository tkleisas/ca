import type { AgentConfig, CaJsonConfig } from "./ca_types.ts";
import { isPathSafe } from "./ca_sandbox.ts";

// ─── Defaults ──────────────────────────────────────────

const DEFAULTS: AgentConfig = {
  model: "deepseek-v4-pro",
  apiKey: "",
  apiBase: "https://api.deepseek.com/v1",
  maxTokens: 384000,
  maxRounds: 100,
  maxRetries: 3,
  temperature: 0.0,
  topP: undefined,
  stop: "",
  responseFormat: "",
  logprobs: false,
  topLogprobs: undefined,
  userId: "",
  thinking: false,
  reasoningEffort: "",
  stream: false,
  sandbox: true,
  approve: false,
  dryRun: false,
  autoCommit: true,
  tools: {
    read_file: true,
    write_file: true,
    run_command: true,
    search_files: true,
    list_directory: true,
    ask_user: true,
    apply_diff: true,
    restart_self: true,
  },
  systemPrompt: undefined,
  systemPromptFile: undefined,
};

let _config: AgentConfig = { ...DEFAULTS, tools: { ...DEFAULTS.tools } };

export function getConfig(): AgentConfig {
  return _config;
}

// ─── Load from Environment ────────────────────────────

function loadEnv(): Partial<AgentConfig> {
  const out: Partial<AgentConfig> = {};

  const s = (key: string) => Deno.env.get(key);
  const b = (key: string) => s(key) === "1" || s(key) === "true";
  const n = (key: string) => s(key) ? parseInt(s(key)!) : undefined;
  const f = (key: string) => s(key) ? parseFloat(s(key)!) : undefined;

  if (s("CA_MODEL")) out.model = s("CA_MODEL")!;
  if (s("CA_API_KEY")) out.apiKey = s("CA_API_KEY")!;
  if (s("CA_API_BASE")) out.apiBase = s("CA_API_BASE")!.replace(/\/+$/, "");
  if (n("CA_MAX_TOKENS")) out.maxTokens = n("CA_MAX_TOKENS")!;
  if (n("CA_MAX_ROUNDS")) out.maxRounds = n("CA_MAX_ROUNDS")!;
  if (n("CA_MAX_RETRIES")) out.maxRetries = n("CA_MAX_RETRIES")!;
  if (f("CA_TEMPERATURE") !== undefined) out.temperature = f("CA_TEMPERATURE")!;
  if (f("CA_TOP_P") !== undefined) out.topP = f("CA_TOP_P")!;
  if (s("CA_STOP")) out.stop = s("CA_STOP")!;
  if (s("CA_RESPONSE_FORMAT")) out.responseFormat = s("CA_RESPONSE_FORMAT")!;
  if (b("CA_LOGPROBS")) out.logprobs = true;
  if (n("CA_TOP_LOGPROBS")) out.topLogprobs = n("CA_TOP_LOGPROBS")!;
  if (s("CA_USER_ID")) out.userId = s("CA_USER_ID")!;
  if (b("CA_THINKING")) out.thinking = true;
  if (s("CA_REASONING_EFFORT")) out.reasoningEffort = s("CA_REASONING_EFFORT")!;
  if (b("CA_STREAM")) out.stream = true;
  if (b("CA_SANDBOX")) out.sandbox = true;
  if (s("CA_SANDBOX") === "0" || s("CA_SANDBOX") === "false") out.sandbox = false;
  if (b("CA_APPROVE")) out.approve = true;
  if (b("CA_DRY_RUN")) out.dryRun = true;
  if (b("CA_AUTO_COMMIT")) out.autoCommit = true;
  if (s("CA_AUTO_COMMIT") === "0" || s("CA_AUTO_COMMIT") === "false") out.autoCommit = false;
  if (s("CA_SYSTEM_PROMPT")) out.systemPrompt = s("CA_SYSTEM_PROMPT")!;
  if (s("CA_SYSTEM_PROMPT_FILE")) out.systemPromptFile = s("CA_SYSTEM_PROMPT_FILE")!;

  return out;
}

// ─── Load .ca.json ─────────────────────────────────────

async function loadCaJson(): Promise<Partial<AgentConfig>> {
  const cwd = Deno.cwd();
  // Walk up directories to find .ca.json
  const parts = cwd.split("/").filter(Boolean);
  const searchPaths: string[] = [];
  for (let i = parts.length; i >= 0; i--) {
    searchPaths.push("/" + parts.slice(0, i).join("/") + "/.ca.json");
  }
  // Also check XDG config
  const xdgHome = Deno.env.get("XDG_CONFIG_HOME") ?? Deno.env.get("HOME") + "/.config";
  searchPaths.push(xdgHome + "/ca/config.json");

  for (const path of searchPaths) {
    try {
      const raw = await Deno.readTextFile(path);
      const parsed: CaJsonConfig = JSON.parse(raw);
      return caJsonToConfig(parsed);
    } catch {
      // File doesn't exist or can't parse, continue
    }
  }

  return {};
}

function caJsonToConfig(json: CaJsonConfig): Partial<AgentConfig> {
  const out: Partial<AgentConfig> = {};

  if (json.model) out.model = json.model;
  if (json.api_key) out.apiKey = json.api_key;
  if (json.api_base) out.apiBase = json.api_base.replace(/\/+$/, "");
  if (json.max_tokens) out.maxTokens = json.max_tokens;
  if (json.max_rounds) out.maxRounds = json.max_rounds;
  if (json.max_retries !== undefined) out.maxRetries = json.max_retries;
  if (json.temperature !== undefined) out.temperature = json.temperature;
  if (json.top_p !== undefined) out.topP = json.top_p;
  if (json.stop) out.stop = json.stop;
  if (json.response_format) out.responseFormat = json.response_format;
  if (json.logprobs !== undefined) out.logprobs = json.logprobs;
  if (json.top_logprobs !== undefined) out.topLogprobs = json.top_logprobs;
  if (json.user_id) out.userId = json.user_id;
  if (json.thinking !== undefined) out.thinking = json.thinking;
  if (json.reasoning_effort) out.reasoningEffort = json.reasoning_effort;
  if (json.stream !== undefined) out.stream = json.stream;
  if (json.sandbox !== undefined) out.sandbox = json.sandbox;
  if (json.approve !== undefined) out.approve = json.approve;
  if (json.auto_commit !== undefined) out.autoCommit = json.auto_commit;
  if (json.system_prompt) out.systemPrompt = json.system_prompt;
  if (json.tools) {
    out.tools = { ...DEFAULTS.tools, ...json.tools };
  }

  return out;
}

// ─── CLI Overrides ─────────────────────────────────────

export function applyCliOverrides(overrides: Partial<AgentConfig>): void {
  if (overrides.model !== undefined) _config.model = overrides.model;
  if (overrides.apiKey !== undefined) _config.apiKey = overrides.apiKey;
  if (overrides.apiBase !== undefined) _config.apiBase = overrides.apiBase.replace(/\/+$/, "");
  if (overrides.maxTokens !== undefined) _config.maxTokens = overrides.maxTokens;
  if (overrides.maxRounds !== undefined) _config.maxRounds = overrides.maxRounds;
  if (overrides.temperature !== undefined) _config.temperature = overrides.temperature;
  if (overrides.topP !== undefined) _config.topP = overrides.topP;
  if (overrides.stop !== undefined) _config.stop = overrides.stop;
  if (overrides.responseFormat !== undefined) _config.responseFormat = overrides.responseFormat;
  if (overrides.logprobs !== undefined) _config.logprobs = overrides.logprobs;
  if (overrides.topLogprobs !== undefined) _config.topLogprobs = overrides.topLogprobs;
  if (overrides.userId !== undefined) _config.userId = overrides.userId;
  if (overrides.thinking !== undefined) _config.thinking = overrides.thinking;
  if (overrides.reasoningEffort !== undefined) _config.reasoningEffort = overrides.reasoningEffort;
  if (overrides.stream !== undefined) _config.stream = overrides.stream;
  if (overrides.sandbox !== undefined) _config.sandbox = overrides.sandbox;
  if (overrides.approve !== undefined) _config.approve = overrides.approve;
  if (overrides.dryRun !== undefined) _config.dryRun = overrides.dryRun;
  if (overrides.autoCommit !== undefined) _config.autoCommit = overrides.autoCommit;
  if (overrides.resumeFile !== undefined) _config.resumeFile = overrides.resumeFile;
  if (overrides.tools) {
    _config.tools = { ..._config.tools, ...overrides.tools };
  }
  if (overrides.systemPrompt !== undefined) _config.systemPrompt = overrides.systemPrompt;
  if (overrides.systemPromptFile !== undefined) _config.systemPromptFile = overrides.systemPromptFile;
}

// ─── Initialize ────────────────────────────────────────

export async function initConfig(cliOverrides: Partial<AgentConfig>): Promise<void> {
  // Load in priority order (later overrides earlier):
  // 1. Defaults
  _config = { ...DEFAULTS, tools: { ...DEFAULTS.tools } };

  // 2. .ca.json file
  const fileConfig = await loadCaJson();
  applyConfig(fileConfig);

  // 3. Environment variables
  const envConfig = loadEnv();
  applyConfig(envConfig);

  // 4. CLI arguments
  applyCliOverrides(cliOverrides);

  // 5. Load system prompt from file if specified
  if (_config.systemPromptFile) {
    try {
      _config.systemPrompt = await Deno.readTextFile(_config.systemPromptFile);
    } catch {
      console.error(`Warning: Could not read system prompt file: ${_config.systemPromptFile}`);
    }
  }
}

function applyConfig(partial: Partial<AgentConfig>): void {
  if (partial.model !== undefined) _config.model = partial.model;
  if (partial.apiKey !== undefined) _config.apiKey = partial.apiKey;
  if (partial.apiBase !== undefined) _config.apiBase = partial.apiBase;
  if (partial.maxTokens !== undefined) _config.maxTokens = partial.maxTokens;
  if (partial.maxRounds !== undefined) _config.maxRounds = partial.maxRounds;
  if (partial.maxRetries !== undefined) _config.maxRetries = partial.maxRetries;
  if (partial.temperature !== undefined) _config.temperature = partial.temperature;
  if (partial.topP !== undefined) _config.topP = partial.topP;
  if (partial.stop !== undefined) _config.stop = partial.stop;
  if (partial.responseFormat !== undefined) _config.responseFormat = partial.responseFormat;
  if (partial.logprobs !== undefined) _config.logprobs = partial.logprobs;
  if (partial.topLogprobs !== undefined) _config.topLogprobs = partial.topLogprobs;
  if (partial.userId !== undefined) _config.userId = partial.userId;
  if (partial.thinking !== undefined) _config.thinking = partial.thinking;
  if (partial.reasoningEffort !== undefined) _config.reasoningEffort = partial.reasoningEffort;
  if (partial.stream !== undefined) _config.stream = partial.stream;
  if (partial.sandbox !== undefined) _config.sandbox = partial.sandbox;
  if (partial.approve !== undefined) _config.approve = partial.approve;
  if (partial.dryRun !== undefined) _config.dryRun = partial.dryRun;
  if (partial.autoCommit !== undefined) _config.autoCommit = partial.autoCommit;
  if (partial.resumeFile !== undefined) _config.resumeFile = partial.resumeFile;
  if (partial.tools) {
    _config.tools = { ..._config.tools, ...partial.tools };
  }
  if (partial.systemPrompt !== undefined) _config.systemPrompt = partial.systemPrompt;
  if (partial.systemPromptFile !== undefined) _config.systemPromptFile = partial.systemPromptFile;
}
