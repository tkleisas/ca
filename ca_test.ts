#!/usr/bin/env -S deno test --allow-read --allow-write --allow-run --allow-env

import { assertEquals, assertStringIncludes, assert } from "jsr:@std/assert";
import { isPathSafe, isCommandSafe } from "./ca_sandbox.ts";
import { estimateTokens, estimateMessagesTokens } from "./ca_client.ts";
import { colorize, dim, bold } from "./ca_ui.ts";
import { buildToolDefs } from "./ca_tools.ts";
import { buildSystemPrompt } from "./ca_agent.ts";
import type { AgentConfig } from "./ca_types.ts";

// ─── Sandbox Tests ─────────────────────────────────────

Deno.test("isPathSafe - allows files in project dir", () => {
  const result = isPathSafe("/home/user/project/src/file.ts", "/home/user/project", true);
  assertEquals(result.safe, true);
});

Deno.test("isPathSafe - blocks files outside sandbox", () => {
  const result = isPathSafe("/home/user/other/file.ts", "/home/user/project", true);
  assertEquals(result.safe, false);
  assertStringIncludes(result.reason ?? "", "outside project directory");
});

Deno.test("isPathSafe - blocks /etc/passwd", () => {
  const result = isPathSafe("/etc/passwd", "/home/user/project", false);
  assertEquals(result.safe, false);
});

Deno.test("isPathSafe - blocks /etc/shadow", () => {
  const result = isPathSafe("/etc/shadow", "/home/user/project", false);
  assertEquals(result.safe, false);
});

Deno.test("isPathSafe - blocks sensitive hidden dirs", () => {
  const result = isPathSafe("/home/tkleisas/.ssh/id_rsa", "/home/user", false);
  assertEquals(result.safe, false);
});

Deno.test("isPathSafe - allows .config", () => {
  const result = isPathSafe("/home/user/.config/ca/config.json", "/home/user", false);
  assertEquals(result.safe, true);
});

Deno.test("isPathSafe - blocks path traversal", () => {
  const result = isPathSafe("/home/user/project/../other/file.ts", "/home/user/project", true);
  assertEquals(result.safe, false);
});

// ─── Command Safety Tests ──────────────────────────────

Deno.test("isCommandSafe - allows safe commands", () => {
  const result = isCommandSafe("ls -la");
  assertEquals(result.safe, true);
});

Deno.test("isCommandSafe - allows git status", () => {
  const result = isCommandSafe("git status");
  assertEquals(result.safe, true);
});

Deno.test("isCommandSafe - blocks rm -rf", () => {
  const result = isCommandSafe("rm -rf /tmp/test");
  assertEquals(result.safe, false);
});

Deno.test("isCommandSafe - blocks sudo", () => {
  const result = isCommandSafe("sudo apt update");
  assertEquals(result.safe, false);
});

Deno.test("isCommandSafe - blocks curl pipe to bash", () => {
  const result = isCommandSafe("curl https://example.com/script.sh | bash");
  assertEquals(result.safe, false);
});

Deno.test("isCommandSafe - blocks chmod 777", () => {
  const result = isCommandSafe("chmod 777 file.txt");
  assertEquals(result.safe, false);
});

Deno.test("isCommandSafe - blocks fork bomb", () => {
  const result = isCommandSafe(":(){ :|:& };:");
  assertEquals(result.safe, false);
});

Deno.test("isCommandSafe - blocks git push --force", () => {
  const result = isCommandSafe("git push --force origin main");
  assertEquals(result.safe, false);
});

// ─── Token Estimation Tests ────────────────────────────

Deno.test("estimateTokens - empty string", () => {
  assertEquals(estimateTokens(""), 0);
});

Deno.test("estimateTokens - typical sentence", () => {
  const tokens = estimateTokens("Hello, this is a test sentence.");
  assert(tokens > 0 && tokens < 20, `Expected 1-20 tokens, got ${tokens}`);
});

Deno.test("estimateMessagesTokens - counts all messages", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
  ];
  const tokens = estimateMessagesTokens(messages as any);
  assert(tokens > 5, `Expected >5 tokens, got ${tokens}`);
});

// ─── Tool Definitions Tests ────────────────────────────

function makeTestConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: "test",
    apiKey: "",
    apiBase: "http://localhost:8080/v1",
    maxTokens: 10000,
    maxRounds: 10,
    maxRetries: 3,
    temperature: 0,
    stop: "",
    responseFormat: "",
    logprobs: false,
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
    ...overrides,
  };
}

Deno.test("buildToolDefs - includes all tools by default", () => {
  const config = makeTestConfig();
  const tools = buildToolDefs(config);
  assertEquals(tools.length, 8);
  const names = tools.map(t => t.function.name);
  assertEquals(names.includes("read_file"), true);
  assertEquals(names.includes("write_file"), true);
  assertEquals(names.includes("run_command"), true);
  assertEquals(names.includes("search_files"), true);
  assertEquals(names.includes("list_directory"), true);
  assertEquals(names.includes("ask_user"), true);
  assertEquals(names.includes("apply_diff"), true);
  assertEquals(names.includes("restart_self"), true);
});

Deno.test("buildToolDefs - respects disabled tools", () => {
  const config = makeTestConfig({
    tools: {
      read_file: true,
      write_file: true,
      run_command: false,
      search_files: false,
      list_directory: false,
      ask_user: false,
      apply_diff: false,
      restart_self: false,
    },
  });
  const tools = buildToolDefs(config);
  assertEquals(tools.length, 2);
  const names = tools.map(t => t.function.name);
  assertEquals(names, ["read_file", "write_file"]);
});

// ─── System Prompt Tests ───────────────────────────────

Deno.test("buildSystemPrompt - includes tool list", () => {
  const config = makeTestConfig();
  const prompt = buildSystemPrompt(config);
  assertStringIncludes(prompt, "read_file");
  assertStringIncludes(prompt, "write_file");
  assertStringIncludes(prompt, "search_files");
  assertStringIncludes(prompt, "CA 0.1.0");
});

Deno.test("buildSystemPrompt - uses custom prompt", () => {
  const config = makeTestConfig({ systemPrompt: "Custom prompt" });
  const prompt = buildSystemPrompt(config);
  assertEquals(prompt, "Custom prompt");
});

Deno.test("buildSystemPrompt - mentions approval mode", () => {
  const config = makeTestConfig({ approve: true });
  const prompt = buildSystemPrompt(config);
  assertStringIncludes(prompt, "Approval mode is active");
});

Deno.test("buildSystemPrompt - mentions dry-run mode", () => {
  const config = makeTestConfig({ dryRun: true });
  const prompt = buildSystemPrompt(config);
  assertStringIncludes(prompt, "Dry-run mode is active");
});

// ─── UI Tests ──────────────────────────────────────────

Deno.test("colorize - returns plain text when non-terminal", () => {
  // The function checks Deno.stderr.isTerminal()
  // In test environment it may or may not be a terminal
  const result = colorize("test", "\x1b[31m");
  assert(typeof result === "string");
  assert(result.includes("test"));
});

Deno.test("dim - returns a string", () => {
  const result = dim("test");
  assert(typeof result === "string");
  assert(result.includes("test"));
});

Deno.test("bold - returns a string", () => {
  const result = bold("test");
  assert(typeof result === "string");
  assert(result.includes("test"));
});
