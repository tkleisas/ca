#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-net --allow-env

const VERSION = "0.1.0";

// ─── Types ─────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// ─── Tools ─────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file at the given path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file. Creates it if it doesn't exist, overwrites if it does. Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to write the file to" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a bash shell command. Returns combined stdout+stderr with exit code. Commands timeout after 120s.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          workdir: { type: "string", description: "Optional working directory. Defaults to current directory." },
        },
        required: ["command"],
      },
    },
  },
];

let SYSTEM_PROMPT = `You are CA ${VERSION}, a coding agent that helps with software engineering tasks.

You have access to three tools:
- read_file(path): Read a file's contents
- write_file(path, content): Create or overwrite a file
- run_command(command, workdir?): Execute a bash shell command

Your own source code lives in ca.ts in the current working directory. You can read it to understand yourself, and use write_file to improve your own design. This is fundamental to your purpose: you are a self-evolving agent.

Guidelines:
- Be thorough: read existing code before modifying it
- Verify your work: use run_command to run tests, linters, or compile
- Follow conventions of the codebase you're working in
- Prefer editing existing files over creating new ones
- If unsure, read relevant files first
- Write clean, idiomatic code`;

// ─── Configuration ─────────────────────────────────────

const CONFIG = {
  model: Deno.env.get("CA_MODEL") ?? "deepseek-chat",
  apiKey: Deno.env.get("CA_API_KEY") ?? "",
  apiBase: (Deno.env.get("CA_API_BASE") ?? "https://api.deepseek.com/v1").replace(/\/+$/, ""),
  maxTokens: parseInt(Deno.env.get("CA_MAX_TOKENS") ?? "8192"),
  maxRounds: parseInt(Deno.env.get("CA_MAX_ROUNDS") ?? "30"),
  temperature: Deno.env.get("CA_TEMPERATURE") ? parseFloat(Deno.env.get("CA_TEMPERATURE")!) : 0.0,
};

// ─── Tool Executors ────────────────────────────────────

async function readFile(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    return `Error reading file: ${(e as Error).message}`;
  }
}

async function writeFile(path: string, content: string): Promise<string> {
  try {
    const lastSep = path.lastIndexOf("/");
    if (lastSep > 0) {
      await Deno.mkdir(path.substring(0, lastSep), { recursive: true });
    }
    await Deno.writeTextFile(path, content);
    return `Successfully wrote ${content.length} bytes to ${path}`;
  } catch (e) {
    return `Error writing file: ${(e as Error).message}`;
  }
}

async function runCommand(command: string, workdir?: string): Promise<string> {
  try {
    const cmd = new Deno.Command("bash", {
      args: ["-c", command],
      cwd: workdir ?? Deno.cwd(),
      stdout: "piped",
      stderr: "piped",
      env: Deno.env.toObject(),
    });

    const { code, stdout, stderr } = await cmd.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);

    let result = "";
    if (out) result += out;
    if (err) result += (result ? "\n" : "") + err;
    result += `\n[exit: ${code}]`;

    if (result.length > 10000) {
      result = result.substring(0, 10000) + "\n...[truncated]";
    }
    return result;
  } catch (e) {
    return `Error running command: ${(e as Error).message}`;
  }
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "read_file":
      return await readFile(args.path as string);
    case "write_file":
      return await writeFile(args.path as string, args.content as string);
    case "run_command":
      return await runCommand(args.command as string, args.workdir as string | undefined);
    default:
      return `Unknown tool: ${name}`;
  }
}

// ─── API Client ────────────────────────────────────────

async function chatCompletion(messages: ChatMessage[]): Promise<ChatMessage> {
  const url = `${CONFIG.apiBase}/chat/completions`;

  const body: Record<string, unknown> = {
    model: CONFIG.model,
    messages,
    max_tokens: CONFIG.maxTokens,
    temperature: CONFIG.temperature,
    tools: TOOLS,
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (CONFIG.apiKey) headers["Authorization"] = `Bearer ${CONFIG.apiKey}`;

  const decoder = new TextDecoder();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        if (response.status === 429 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        throw new Error(`API ${response.status}: ${text.substring(0, 500)}`);
      }

      const data = await response.json();
      return data.choices[0].message as ChatMessage;
    } catch (e) {
      if (attempt === 2) throw e;
      const delay = 1000 * (attempt + 1);
      console.error(`[ca] Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

// ─── Agent Loop ────────────────────────────────────────

async function run(prompt: string): Promise<void> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  for (let round = 1; round <= CONFIG.maxRounds; round++) {
    console.error(`[ca] Round ${round}/${CONFIG.maxRounds}`);
    const response = await chatCompletion(messages);
    messages.push(response);

    if (response.tool_calls?.length) {
      for (const tc of response.tool_calls) {
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          console.error(`[ca] Failed to parse arguments for ${name}`);
        }

        const argsStr = JSON.stringify(args);
        const preview = argsStr.length > 80 ? argsStr.substring(0, 80) + "..." : argsStr;
        console.error(`[ca] ${name} ${preview}`);

        const result = await executeTool(name, args);
        console.error(`[ca] ${name} done (${result.length} bytes)`);

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
    } else {
      if (response.content) {
        console.log(response.content);
      }
      return;
    }
  }
  console.error(`[ca] Reached max rounds (${CONFIG.maxRounds})`);
}

// ─── CLI ───────────────────────────────────────────────

function help(): void {
  console.log(`CA ${VERSION} - Coding Agent

Usage: deno run -A ca.ts [options] <prompt>

Options:
  -h, --help          Show this help
  -v, --version       Show version
  -m, --model <name>  Model (default: deepseek-chat)

Environment:
  CA_MODEL            Model name (default: deepseek-chat)
  CA_API_KEY          API key (required for remote APIs)
  CA_API_BASE         API base URL (default: https://api.deepseek.com/v1)
  CA_MAX_TOKENS       Max tokens per response (default: 8192)
  CA_MAX_ROUNDS       Max agent rounds (default: 30)
  CA_TEMPERATURE      Temperature (default: 0.0)
  CA_SYSTEM_PROMPT    Custom system prompt

Examples:
  CA_API_KEY=sk-... deno run -A ca.ts "write a hello world script in rust"

  # Local llama.cpp server
  CA_MODEL=qwen3-6b CA_API_BASE=http://localhost:8080/v1 \\
    deno run -A ca.ts "review the codebase"

  # Self-improvement
  CA_API_KEY=sk-... deno run -A ca.ts \\
    "read ca.ts, analyze it, and improve error handling"`);
}

async function main(): Promise<void> {
  const args = Deno.args;
  let promptParts: string[] = [];
  let i = 0;

  while (i < args.length) {
    const a = args[i];
    if (a === "-h" || a === "--help") { help(); Deno.exit(0); }
    else if (a === "-v" || a === "--version") { console.log(`CA ${VERSION}`); Deno.exit(0); }
    else if ((a === "-m" || a === "--model") && args[i + 1]) { CONFIG.model = args[++i]; i++; }
    else if (a === "--api-base" && args[i + 1]) { CONFIG.apiBase = args[++i].replace(/\/+$/, ""); i++; }
    else if (a === "--api-key" && args[i + 1]) { CONFIG.apiKey = args[++i]; i++; }
    else if (a === "--max-tokens" && args[i + 1]) { CONFIG.maxTokens = parseInt(args[++i]); i++; }
    else if (a === "--max-rounds" && args[i + 1]) { CONFIG.maxRounds = parseInt(args[++i]); i++; }
    else if (a === "--temperature" && args[i + 1]) { CONFIG.temperature = parseFloat(args[++i]); i++; }
    else if (a === "--system-prompt" && args[i + 1]) {
      SYSTEM_PROMPT = await Deno.readTextFile(args[++i]);
      i++;
    }
    else { promptParts.push(a); i++; }
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    console.error("Error: No prompt. Use -h for help.");
    Deno.exit(1);
  }

  const isLocal = CONFIG.apiBase.includes("localhost") || CONFIG.apiBase.includes("127.0.0.1");
  if (!CONFIG.apiKey && !isLocal) {
    console.error("Error: CA_API_KEY not set. Use --api-key, CA_API_KEY env, or a local API base.");
    Deno.exit(1);
  }

  await run(prompt);
}

main().catch((e) => {
  console.error(`[ca] ${(e as Error).message}`);
  Deno.exit(1);
});
