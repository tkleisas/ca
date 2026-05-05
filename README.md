# CA — Self-Evolving Coding Agent

A CLI coding agent powered by LLMs that reads, writes, searches, and executes code — including modifying its own source. Built in TypeScript for [Deno](https://deno.com).

```
CA 0.1.0 — Self-Evolving Coding Agent
────────────────────────────────────────────────────
Model: deepseek-v4-pro  Base: https://api.deepseek.com/v1
Flags: sandbox
────────────────────────────────────────────────────

Type \e on a new line to submit multi-line input. /help for commands.

❯ Write a Rust script that prints "Hello, world!"
```

## Features

- **8 built-in tools** — `read_file`, `write_file`, `run_command`, `search_files`, `list_directory`, `ask_user`, `apply_diff`, `restart_self`
- **Interactive mode** — multi-turn conversations with multi-line input, command history, save/load
- **Single-shot mode** — one-off prompts from the command line
- **Path sandboxing** — restricts file access to the project directory; blocks sensitive system paths
- **Command safety** — detects and blocks 22 dangerous shell patterns (`rm -rf`, `sudo`, `curl | bash`, fork bombs, etc.)
- **Approval mode** — prompts for confirmation before writes, dangerous commands, and diffs
- **Dry-run mode** — previews all actions without modifying anything
- **Parallel tool execution** — multiple independent tool calls run concurrently
- **Project context injection** — auto-detects git branch, changed files, directory structure, and language
- **Token budget management** — warns at 85% and stops at 100% of the context window
- **Conversation persistence** — save and load sessions to/from JSON files
- **Streaming support** — SSE-based real-time response streaming
- **Configurable** — `.ca.json` files, environment variables, and CLI flags
- **Self-evolving** — can read and modify its own source code in `ca.ts` and `ca_*.ts` modules

## Installation

### Prerequisites

- [Deno](https://deno.com/) 2.0 or later
- An API key for your LLM provider (DeepSeek, OpenAI-compatible, or local)

### Setup

```bash
# Clone or download ca.ts and its modules
git clone <your-repo>
cd ca

# Make it executable (optional)
chmod +x ca.ts
```

No install step — Deno runs TypeScript directly.

## Quick Start

```bash
# Set your API key
export CA_API_KEY=sk-your-key-here

# Interactive mode
deno run -A ca.ts -i

# Single-shot mode
deno run -A ca.ts "explain what this project does"

# Self-improvement
deno run -A ca.ts "read all ca_*.ts files, find bugs, and fix them"
```

### Local Models

```bash
# llama.cpp / Ollama / any OpenAI-compatible local server
CA_MODEL=qwen3-6b \
CA_API_BASE=http://localhost:8080/v1 \
  deno run -A ca.ts -i
```

## Tools

CA has 7 tools available to the agent. Each can be enabled or disabled in configuration.

### `read_file(path)`
Read a file's contents. Returns the file with line numbers for easy reference.

```
📖 read_file {"path": "ca.ts"}
```

### `write_file(path, content)`
Create or overwrite a file. Parent directories are created automatically. In approval mode, prompts before writing.

```
✏️ write_file {"path": "src/main.rs", "content": "fn main() {\n    println!(\"Hello\");\n}\n"}
```

### `run_command(command, workdir?)`
Execute a bash shell command. Returns stdout, stderr, and exit code. Output truncated at 10,000 characters. Commands timeout after 120 seconds. Dangerous commands are blocked unless `--approve` is active.

```
⚡ run_command {"command": "cargo build", "workdir": "./src"}
```

### `search_files(pattern, path?, glob?, maxResults?)`
Search for a regex pattern in files. Uses [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) if available, falls back to `grep`. Returns matching lines with file paths and line numbers. Automatically excludes `.git`, `node_modules`, `dist`, `target`.

```
🔍 search_files {"pattern": "function\\s+executeTool", "glob": "*.ts"}
```

### `list_directory(path?, depth?)`
List directory contents. Directories are shown first, sorted alphabetically. Hidden files skipped (except `.ca.json`). Depth clamped to 1–5.

```
📁 list_directory {"path": "./src", "depth": 2}
```

### `ask_user(question)`
Ask the user a clarifying question. Pauses the agent loop and prompts for input. Only available in interactive mode.

```
💬 ask_user {"question": "Should I use React or Vue for this component?"}
```

### `apply_diff(path, search, replace)`
Apply a targeted change using exact string matching. The `search` block must match exactly once in the file (including whitespace). This is preferred over `write_file` for small, precise edits.

```
📝 apply_diff {"path": "ca.ts", "search": "const VERSION = \"0.1.0\";", "replace": "const VERSION = \"0.2.0\";"}
```

## Interactive Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/history` | Show full conversation history |
| `/clear` | Clear conversation (keeps system prompt) |
| `/model` | Show current model, API base, and all configuration |
| `/system [text]` | View system prompt, or set it to `text` |
| `/context` | Refresh auto-detected project context |
| `/save <file>` | Save conversation to a JSON file |
| `/load <file>` | Load conversation from a JSON file |
| `/edit` | Remove the last user+assistant exchange |
| `/tokens` | Show estimated token usage and percentage |
| `/quit` or `/exit` | Exit |

### Multi-line Input

Type your prompt across multiple lines. Finish with `\e` on a new line to submit:

```
❯ Write a Python script that:
│ - Reads a CSV file
│ - Computes summary statistics
│ - Outputs a formatted report
│ \e
```

## Configuration

CA loads configuration from four sources, in priority order (later overrides earlier):

1. **Hardcoded defaults**
2. **`.ca.json` file** — searched from the current directory up to root, plus `~/.config/ca/config.json`
3. **Environment variables** — prefixed with `CA_`
4. **CLI flags** — provided at invocation

### `.ca.json` Example

```json
{
  "model": "deepseek-v4-pro",
  "api_base": "https://api.deepseek.com/v1",
  "max_tokens": 100000,
  "temperature": 0.0,
  "thinking": false,
  "sandbox": true,
  "tools": {
    "read_file": true,
    "write_file": true,
    "run_command": true,
    "search_files": true,
    "list_directory": true,
    "ask_user": true,
    "apply_diff": true
  },
  "system_prompt": "You are a Rust expert. Always use idiomatic Rust patterns."
}
```

Place this in your project root to set project-specific defaults for the whole team.

### Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CA_MODEL` | string | `deepseek-v4-pro` | Model name |
| `CA_API_KEY` | string | — | API key (required for remote APIs) |
| `CA_API_BASE` | string | `https://api.deepseek.com/v1` | API base URL |
| `CA_MAX_TOKENS` | number | `384000` | Max tokens per API response |
| `CA_MAX_ROUNDS` | number | `100` | Max agent tool-calling rounds |
| `CA_TEMPERATURE` | float | `0.0` | Sampling temperature (0–2) |
| `CA_TOP_P` | float | — | Nucleus sampling (0–1) |
| `CA_STOP` | string | — | Stop sequence(s), comma-separated |
| `CA_RESPONSE_FORMAT` | string | — | `json` for JSON mode |
| `CA_LOGPROBS` | flag | — | Return log probabilities |
| `CA_TOP_LOGPROBS` | number | — | Most likely tokens per position |
| `CA_USER_ID` | string | — | User ID for KVCache isolation |
| `CA_STREAM` | flag | — | Enable SSE streaming |
| `CA_THINKING` | flag | — | Enable thinking/reasoning mode |
| `CA_REASONING_EFFORT` | string | — | Reasoning effort (`high`, `max`) |
| `CA_SYSTEM_PROMPT` | string | — | Custom system prompt text |
| `CA_SYSTEM_PROMPT_FILE` | string | — | Path to system prompt file |
| `CA_SANDBOX` | flag | `1` | Enable path sandboxing |
| `CA_APPROVE` | flag | — | Require approval for writes/commands |
| `CA_DRY_RUN` | flag | — | Preview mode (no modifications) |

### CLI Flags

```
Usage:
  deno run -A ca.ts [options] <prompt>
  deno run -A ca.ts [options] -i              (interactive mode)

Options:
  -h, --help                      Show this help
  -v, --version                   Show version
  -i, --interactive               Start interactive session
  -m, --model <name>              Model (default: deepseek-v4-pro)
  --api-base <url>                API base URL
  --api-key <key>                 API key
  --max-tokens <n>                Max tokens per response (default: 384000)
  --max-rounds <n>                Max agent rounds (default: 100)
  --temperature <f>               Temperature (0-2, default: 0.0)
  --top-p <f>                     Top P nucleus sampling (0-1)
  --stop <seq>                    Stop sequence(s), comma-separated
  --response-format <type>        Response format (text, json)
  --logprobs                      Return log probabilities
  --top-logprobs <n>              Most likely tokens per position (max 20)
  --user-id <id>                  User ID for KVCache isolation
  --stream                        Enable streaming responses
  --thinking                      Enable thinking/reasoning mode
  --reasoning-effort <level>      Reasoning effort (high, max)
  --system-prompt <file>          Path to system prompt file
  --sandbox                       Enable path sandboxing (default: on)
  --no-sandbox                    Disable path sandboxing
  --approve                       Require approval for writes & commands
  --dry-run                       Show what would be done without doing it
```

## Safety

### Path Sandboxing

When enabled (default), all file access is restricted to the project directory. The following are **always blocked**, even with `--no-sandbox`:

- `/etc/*` — system configuration files
- `/dev/*`, `/proc/*`, `/sys/*` — device and kernel interfaces
- `/boot/*`, `/root/*` — boot files and root home
- `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.kube`, `~/.gcloud`, `~/.azure` — credentials

### Command Safety

19 dangerous patterns are detected and blocked:

| Pattern | Examples blocked |
|---------|-----------------|
| Destructive deletion | `rm -rf`, `rm -r` |
| Privilege escalation | `sudo ...` |
| Permission changes | `chmod 777`, `chmod -R` |
| Ownership changes | `chown` |
| Filesystem formatting | `mkfs.*` |
| Disk duplication | `dd if=` |
| Device writes | `> /dev/*` |
| Curl/wget piped to shell | `curl ... \| bash` |
| Force push | `git push --force`, `git push -f` |
| Docker prune | `docker rm`, `docker system prune` |
| System shutdown | `shutdown`, `reboot` |
| Force kill | `kill -9`, `pkill` |
| Fork bombs | `:(){ :\|:& };:` |

Use `--approve` to be prompted before executing dangerous commands.

### Approval Mode (`--approve`)

When enabled, you'll be prompted `[y/N]` before:
- `write_file` — shows path and content preview
- `run_command` — shows the command and why it's flagged
- `apply_diff` — shows the search and replace blocks

### Dry-Run Mode (`--dry-run`)

All tools report what they *would* do without making any changes. The agent completes exactly one round. Great for reviewing before committing.

```bash
deno run -A ca.ts --dry-run "refactor the error handling in ca_tools.ts"
```

## Architecture

```
ca.ts            CLI parsing, interactive mode, main entry point
ca_types.ts      All TypeScript interfaces and types
ca_ui.ts         ANSI colors, spinner, banner, syntax highlighting, prompts
ca_sandbox.ts    Path validation, command danger detection
ca_config.ts     Configuration loading (.ca.json → env → CLI)
ca_tools.ts      Tool definitions and executors (7 tools)
ca_client.ts     API client, streaming (SSE), token estimation
ca_agent.ts      Agent loop, project context, save/load, system prompt
ca_test.ts       27 unit tests
```

### Dependency Graph

```
ca.ts
├── ca_agent.ts
│   ├── ca_tools.ts
│   │   ├── ca_types.ts
│   │   ├── ca_ui.ts
│   │   └── ca_sandbox.ts
│   ├── ca_client.ts
│   │   ├── ca_types.ts
│   │   └── ca_ui.ts
│   └── ca_ui.ts
├── ca_config.ts
│   ├── ca_types.ts
│   └── ca_sandbox.ts
└── ca_ui.ts
```

### Agent Loop

```
1. Build system prompt + inject project context
2. Add user message
3. FOR each round (up to maxRounds):
   a. Check token budget (warn at 85%, stop at 100%)
   b. Call API (with retry logic)
   c. If tool_calls:
      - Execute all tools in PARALLEL (Promise.all)
      - Check results for errors (auto-retry next round)
      - Feed tool results back as messages
      - Continue loop
   d. If no tool_calls:
      - Print response content
      - Return messages (conversation state)
4. If maxRounds reached: warn and return
```

### Token Budget

CA estimates tokens at `~3.5 chars/token` (conservative for most models). The actual API `usage` field is also tracked when available. Warnings are emitted at 85% of the configured `max_tokens`.

## Examples

### Basic Usage

```bash
# Write a new script
CA_API_KEY=sk-... deno run -A ca.ts "write a Python script that downloads and parses a CSV file"

# Review existing code
CA_API_KEY=sk-... deno run -A ca.ts "review the error handling in ca_client.ts"

# Refactor
CA_API_KEY=sk-... deno run -A ca.ts "extract the spinner logic from ca_ui.ts into its own module"
```

### Interactive Sessions

```bash
# Start an interactive session with thinking enabled
CA_API_KEY=sk-... CA_THINKING=1 deno run -A ca.ts -i

# With a custom system prompt
CA_API_KEY=sk-... CA_SYSTEM_PROMPT="You are a Zig expert." deno run -A ca.ts -i

# Save and resume work
CA_API_KEY=sk-... deno run -A ca.ts -i
❯ /save session.json
❯ /quit

# Later...
CA_API_KEY=sk-... deno run -A ca.ts -i
❯ /load session.json
❯ continue where we left off
```

### Safety Modes

```bash
# Preview only — see what the agent would do
deno run -A ca.ts --dry-run "delete all TODO comments from the codebase"

# Require approval for every write
deno run -A ca.ts --approve -i

# Disable sandbox for system-wide tasks (use with caution!)
deno run -A ca.ts --no-sandbox "check which processes are using port 3000"
```

### Self-Improvement

```bash
# Have CA analyze itself
deno run -A ca.ts "read all ca_*.ts files and suggest 3 improvements with specific code changes"

# Have CA fix issues it finds
deno run -A ca.ts "read ca_tools.ts and ca_sandbox.ts — the search_files tool doesn't handle binary files well, add a binary file filter"
```

### Project Configuration

Create a `.ca.json` in your project root:

```json
{
  "system_prompt": "You are a Rust systems programmer. Follow the Rust API guidelines. Use anyhow for error handling. Prefer iterators over loops. Write comprehensive doc comments.",
  "temperature": 0.1,
  "tools": {
    "ask_user": false
  }
}
```

Now every CA invocation in that directory uses these settings automatically.

## Testing

```bash
# Run all tests
deno test -A ca_test.ts

# Run a specific test
deno test -A ca_test.ts --filter "isCommandSafe"
```

27 tests covering:
- Path sandboxing (7 tests)
- Command safety (8 tests)
- Token estimation (2 tests)
- Tool definitions (2 tests)
- System prompt building (4 tests)
- UI utilities (3 tests)

## API Compatibility

CA uses the OpenAI-compatible chat completions API. It has been tested with:

- **DeepSeek** (`api.deepseek.com`) — primary target
- **OpenAI** (`api.openai.com`) — compatible
- **llama.cpp** / **Ollama** — any local server with `/v1/chat/completions`
- **Anthropic** — via compatible proxy (e.g. LiteLLM)

Any provider that supports the tool-calling (`tools` in the request body) and follows the OpenAI message format should work.

## License

MIT

## Contributing

CA can improve itself! Try:

```bash
deno run -A ca.ts "read ca.ts and all ca_*.ts, analyze the code for bugs and improvements, and implement the best ones"
```
