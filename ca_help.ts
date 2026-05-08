import { VERSION } from "./ca_types.ts";
import { C, colorize, dim, bold } from "./ca_ui.ts";

export function help(): void {
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
  ${c("--max-tokens")} ${d("<n>")}                ${d("Max context tokens before stopping (default: 1,000,000)")}
  ${c("--max-output-tokens")} ${d("<n>")}         ${d("Max tokens per API response (default: 384,000)")}
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
