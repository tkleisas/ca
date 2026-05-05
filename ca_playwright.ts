/**
 * ca_playwright.ts — Playwright-based web UI testing for CA
 *
 * Launches a headless browser, connects to the CA web UI via WebSocket,
 * runs a battery of E2E tests, and reports results.
 *
 * Usage:
 *   deno run -A ca_playwright.ts --port 9420
 *   deno run -A ca_playwright.ts --port 9420 --quick  (fast smoke test)
 *
 * Dependencies: npm:playwright (auto-installed by Deno)
 * Browser binary: npx playwright install chromium (one-time setup)
 */

import type { AgentConfig } from "./ca_types.ts";
import { VERSION } from "./ca_types.ts";
import { startWebServer, type WebServerHandle } from "./ca_web.ts";
import { getConfig } from "./ca_config.ts";

// ─── Test Result Types ──────────────────────────────────

export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: string;
}

export interface TestSuiteResult {
  suite: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  tests: TestResult[];
}

// ─── Playwright WebSocket Client ────────────────────────

interface WsMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Lightweight test that uses Deno's built-in WebSocket (no Playwright needed).
 * Tests the WebSocket API directly. Fast, zero dependencies.
 */
export async function testWebSocketApi(port: number, timeoutMs = 15000): Promise<TestSuiteResult> {
  const tests: TestResult[] = [];
  const start = Date.now();

  async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
    const t0 = Date.now();
    try {
      await fn();
      tests.push({ name, passed: true, duration: Date.now() - t0 });
    } catch (e) {
      tests.push({ name, passed: false, duration: Date.now() - t0, error: (e as Error).message });
    }
  }

  // ─── Test 1: WebSocket connection ──────────────────────
  await runTest("WebSocket connection", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const openPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Connection timeout")), 5000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = (e) => { clearTimeout(timer); reject(new Error("WebSocket error")); };
    });
    await openPromise;
    ws.close();
  });

  // ─── Test 2: Receive banner on connect ─────────────────
  await runTest("Receive banner event", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const bannerPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Banner timeout")), 5000);
      ws.onmessage = (e) => {
        const msg: WsMessage = JSON.parse(e.data);
        if (msg.type === "banner") {
          clearTimeout(timer);
          if (msg.model && msg.version) resolve();
          else reject(new Error("Banner missing fields"));
        }
      };
    });
    await bannerPromise;
    ws.close();
  });

  // ─── Test 3: Receive context event ─────────────────────
  await runTest("Receive context event", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const ctxPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Context timeout")), 5000);
      ws.onmessage = (e) => {
        const msg: WsMessage = JSON.parse(e.data);
        if (msg.type === "context") {
          clearTimeout(timer);
          if (typeof msg.content === "string" && msg.content.length > 0) resolve();
          else reject(new Error("Context missing content"));
        }
      };
    });
    await ctxPromise;
    ws.close();
  });

  // ─── Test 4: File browser listing ──────────────────────
  await runTest("File browser dir listing", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const listPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Dir listing timeout")), 5000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "list_dir" }));
      };
      ws.onmessage = (e) => {
        const msg: WsMessage = JSON.parse(e.data);
        if (msg.type === "dir_listing") {
          clearTimeout(timer);
          if (Array.isArray(msg.entries)) resolve();
          else reject(new Error("Dir listing missing entries array"));
        }
      };
    });
    await listPromise;
    ws.close();
  });

  // ─── Test 5: Read a known file ─────────────────────────
  await runTest("Read file via WebSocket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const filePromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Read file timeout")), 5000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "read_file", path: "ca_types.ts" }));
      };
      ws.onmessage = (e) => {
        const msg: WsMessage = JSON.parse(e.data);
        if (msg.type === "file_content") {
          clearTimeout(timer);
          if (typeof msg.content === "string" && msg.content.length > 0) resolve();
          else reject(new Error("File content missing or empty"));
        } else if (msg.type === "error") {
          clearTimeout(timer);
          reject(new Error(`Server error: ${msg.message}`));
        }
      };
    });
    await filePromise;
    ws.close();
  });

  // ─── Test 6: Session list ──────────────────────────────
  await runTest("Session list", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const sessPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Session list timeout")), 5000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "session_list" }));
      };
      ws.onmessage = (e) => {
        const msg: WsMessage = JSON.parse(e.data);
        if (msg.type === "session_list") {
          clearTimeout(timer);
          if (Array.isArray(msg.sessions)) resolve();
          else reject(new Error("Session list missing sessions array"));
        }
      };
    });
    await sessPromise;
    ws.close();
  });

  // ─── Test 7: HTTP page serves ─────────────────────────
  await runTest("HTTP page serves HTML", async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/`);
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    if (!html.includes("<!DOCTYPE html>")) throw new Error("Not HTML");
    if (!html.includes("CA " + VERSION)) throw new Error("Missing version");
    if (!html.includes("WebSocket")) throw new Error("Missing WebSocket reference");
  });

  // ─── Test 8: Token update events ───────────────────────
  await runTest("Token update events", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const tokenPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Token update timeout")), 5000);
      ws.onmessage = (e) => {
        const msg: WsMessage = JSON.parse(e.data);
        if (msg.type === "token_update") {
          clearTimeout(timer);
          if (typeof msg.used === "number" && typeof msg.max === "number") resolve();
          else reject(new Error("Token update missing fields"));
        }
      };
    });
    await tokenPromise;
    ws.close();
  });

  const passed = tests.filter(t => t.passed).length;
  const failed = tests.filter(t => !t.passed).length;

  return {
    suite: "WebSocket API",
    passed,
    failed,
    skipped: 0,
    duration: Date.now() - start,
    tests,
  };
}

// ─── Playwright Browser Tests ────────────────────────────

/**
 * Run full browser-based tests using Playwright.
 * Requires: npx playwright install chromium (one-time)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlPage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlBrowser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PlContext = any;

export async function testWithPlaywright(port: number, quick = false): Promise<TestSuiteResult> {
  const tests: TestResult[] = [];
  const start = Date.now();
  let browser: PlBrowser = null;

  async function runTest(name: string, fn: (page: PlPage) => Promise<void>): Promise<void> {
    const t0 = Date.now();
    try {
      await fn(null!); // page will be set up below
      tests.push({ name, passed: true, duration: Date.now() - t0 });
    } catch (e) {
      tests.push({ name, passed: false, duration: Date.now() - t0, error: (e as Error).message });
    }
  }

  try {
    // Dynamic import of Playwright
    const { chromium } = await import("npm:playwright@1.49.1");

    browser = await chromium.launch({ headless: true });
    const context: PlContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page: PlPage = await context.newPage();

    // ─── Browser Test 1: Page loads ──────────────────────
    await runTest("[Browser] Page loads successfully", async () => {
      const resp = await page.goto(`http://127.0.0.1:${port}/`);
      if (resp.status() !== 200) throw new Error(`HTTP ${resp.status()}`);
    });

    // ─── Browser Test 2: Title is correct ─────────────────
    await runTest("[Browser] Page title", async () => {
      const title = await page.title();
      if (!title.includes("CA")) throw new Error(`Unexpected title: ${title}`);
    });

    // ─── Browser Test 3: Sidebar elements visible ─────────
    await runTest("[Browser] Sidebar elements", async () => {
      await page.waitForSelector("#sb-header", { timeout: 5000 });
      await page.waitForSelector("#messages", { timeout: 3000 });
      await page.waitForSelector("#input", { timeout: 3000 });
      await page.waitForSelector("#send-btn", { timeout: 3000 });
    });

    if (!quick) {
      // ─── Browser Test 4: File browser tab ──────────────────
      await runTest("[Browser] File browser tab switch", async () => {
        await page.waitForSelector("#tab-files", { timeout: 3000 });
        await page.click("#tab-files");
        await page.waitForSelector("#file-browser .fb-entry, #file-browser .fb-empty", { timeout: 5000 });
      });

      // ─── Browser Test 5: Sessions tab ──────────────────────
      await runTest("[Browser] Sessions tab", async () => {
        await page.click("#tab-sessions");
        await page.waitForSelector("#sessions-list", { timeout: 5000 });
      });

      // ─── Browser Test 6: Input area functional ─────────────
      await runTest("[Browser] Input and send button", async () => {
        await page.click("#tab-context");
        const inputDisabled = await page.isDisabled("#input");
        const btnDisabled = await page.isDisabled("#send-btn");
        if (inputDisabled) throw new Error("Input should be enabled");
        if (btnDisabled) throw new Error("Send button should be enabled");
        await page.type("#input", "test message");
      });

      // ─── Browser Test 7: Status text ───────────────────────
      await runTest("[Browser] Status indicator", async () => {
        await page.waitForSelector("#status", { timeout: 3000 });
        const statusText = await page.textContent("#status");
        if (!statusText || statusText.includes("connecting")) {
          await new Promise(r => setTimeout(r, 2000));
          const retryText = await page.textContent("#status");
          if (retryText && retryText.includes("connecting")) {
            throw new Error("Status still connecting after wait");
          }
        }
      });
    }

    // ─── Browser Test 8: WebSocket connected ──
    await runTest("[Browser] WebSocket connected", async () => {
      await page.waitForSelector("#status", { timeout: 3000 });
      for (let i = 0; i < 25; i++) {
        const text = await page.textContent("#status");
        if (text && !text.includes("connecting") && !text.includes("error")) return;
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error("WebSocket never connected properly");
    });

    await context.close();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    // If Playwright itself fails (not installed), record as skipped
    if (msg.includes("Executable doesn't exist") || msg.includes("playwright")) {
      return {
        suite: "Playwright Browser",
        passed: 0, failed: 0, skipped: tests.length + 1,
        duration: Date.now() - start, tests,
      };
    }
    if (tests.length > 0) {
      tests[tests.length - 1].passed = false;
      tests[tests.length - 1].error = (e as Error).message;
    } else {
      tests.push({ name: "[Browser] Setup", passed: false, duration: Date.now() - start, error: (e as Error).message });
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ok */ }
    }
  }

  const passed = tests.filter(t => t.passed).length;
  const failed = tests.filter(t => !t.passed).length;

  return {
    suite: "Playwright Browser",
    passed, failed, skipped: 0,
    duration: Date.now() - start, tests,
  };
}

// ─── Full Test Runner ────────────────────────────────────

export interface FullTestResults {
  wsApi: TestSuiteResult;
  browser: TestSuiteResult | null;
  totalPassed: number;
  totalFailed: number;
  totalDuration: number;
}

/**
 * Run all web tests:
 * 1. Start the web server on the given port
 * 2. Run WebSocket API tests (fast, zero deps)
 * 3. Optionally run Playwright browser tests
 * 4. Shut down the server
 */
export async function runAllWebTests(
  port: number,
  config: AgentConfig,
  opts: { playwright?: boolean; quick?: boolean; timeout?: number } = {},
): Promise<FullTestResults> {
  const { playwright = false, quick = false, timeout = 30000 } = opts;
  const results: FullTestResults = {
    wsApi: { suite: "WebSocket API", passed: 0, failed: 0, skipped: 0, duration: 0, tests: [] },
    browser: null,
    totalPassed: 0,
    totalFailed: 0,
    totalDuration: 0,
  };

  // Start web server
  const server = startWebServer(config, port);
  // Give the server a moment to start
  await new Promise(r => setTimeout(r, 500));

  const deadline = Date.now() + timeout;

  try {
    // 1. Run WebSocket API tests
    results.wsApi = await testWebSocketApi(port, Math.max(0, deadline - Date.now()));
    results.totalPassed += results.wsApi.passed;
    results.totalFailed += results.wsApi.failed;

    // 2. Optionally run Playwright tests
    if (playwright && Date.now() < deadline) {
      try {
        results.browser = await testWithPlaywright(port, quick);
        results.totalPassed += results.browser.passed;
        results.totalFailed += results.browser.failed;
      } catch (e) {
        results.browser = {
          suite: "Playwright Browser",
          passed: 0, failed: 1, skipped: 0,
          duration: 0,
          tests: [{ name: "Playwright setup", passed: false, duration: 0, error: (e as Error).message }],
        };
        results.totalFailed++;
      }
    }
  } finally {
    // Always shut down
    server.shutdown();
  }

  results.totalDuration = results.wsApi.duration + (results.browser?.duration ?? 0);
  return results;
}

// ─── Format Results ──────────────────────────────────────

export function formatTestResults(results: FullTestResults): string {
  const lines: string[] = [];
  const total = results.totalPassed + results.totalFailed;
  const icon = results.totalFailed === 0 ? "✓" : "✗";

  lines.push(`${icon} Web Tests: ${results.totalPassed}/${total} passed (${results.totalDuration}ms)`);
  lines.push("");

  // WS API results
  lines.push(`  WebSocket API: ${results.wsApi.passed}/${results.wsApi.passed + results.wsApi.failed} passed`);
  for (const t of results.wsApi.tests) {
    const mark = t.passed ? "✓" : "✗";
    lines.push(`    ${mark} ${t.name} (${t.duration}ms)${t.error ? ` — ${t.error}` : ""}`);
  }

  // Browser results
  if (results.browser) {
    lines.push("");
    const bTotal = results.browser.passed + results.browser.failed + results.browser.skipped;
    lines.push(`  Playwright Browser: ${results.browser.passed}/${bTotal} passed`);
    for (const t of results.browser.tests) {
      const mark = t.passed ? "✓" : "✗";
      lines.push(`    ${mark} ${t.name} (${t.duration}ms)${t.error ? ` — ${t.error}` : ""}`);
    }
  }

  return lines.join("\n");
}

// ─── CLI Entry Point ─────────────────────────────────────

async function main(): Promise<void> {
  const args = Deno.args;
  let port = 9420;
  let playwright = false;
  let quick = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i]);
    } else if (args[i] === "--playwright") {
      playwright = true;
    } else if (args[i] === "--quick" || args[i] === "-q") {
      quick = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`CA Web Test Runner
Usage: deno run -A ca_playwright.ts [options]

Options:
  --port <n>       Port for the web server (default: 9420)
  --playwright     Also run full browser tests via Playwright
  --quick, -q      Quick mode: skip slow browser tests
  --help, -h       Show this help

Without --playwright, runs WebSocket API tests only (zero deps).
With --playwright, also launches a headless Chromium browser.
Requires: npx playwright install chromium (one-time setup)`);
      Deno.exit(0);
    }
  }

  const config = getConfig();

  console.log(`CA Web Test Runner — port ${port}`);
  console.log("");

  const results = await runAllWebTests(port, config, { playwright, quick });
  console.log(formatTestResults(results));

  const exitCode = results.totalFailed > 0 ? 1 : 0;
  Deno.exit(exitCode);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`Fatal: ${(e as Error).message}`);
    Deno.exit(1);
  });
}
