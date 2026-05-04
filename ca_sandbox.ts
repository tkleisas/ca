import type { SafetyCheck } from "./ca_types.ts";

// ─── Path Safety ───────────────────────────────────────

/**
 * Check if a file path is safe to access.
 * In sandbox mode, restricts access to the project directory.
 * Always blocks access to sensitive system paths.
 */
export function isPathSafe(path: string, cwd: string, sandbox: boolean): SafetyCheck {
  // Resolve to absolute path
  let resolved: string;
  try {
    // Handle relative paths
    if (path.startsWith("/")) {
      resolved = path;
    } else {
      resolved = `${cwd}/${path}`;
    }
    // Normalize: resolve .. and .
    const parts = resolved.split("/");
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === "..") {
        if (normalized.length > 0) normalized.pop();
      } else if (part !== "." && part !== "") {
        normalized.push(part);
      }
    }
    resolved = "/" + normalized.join("/");
  } catch {
    return { safe: false, reason: "Unable to resolve path" };
  }

  // Block sensitive paths regardless of sandbox mode
  const blockedPrefixes = [
    "/etc/", "/dev/", "/proc/", "/sys/", "/boot/",
    "/root/", "/var/log/", "/var/run/",
    "/Library/", "/System/", "/private/etc/", "/private/var/",
    "C:\\Windows", "C:\\Program Files",
  ];

  // Block sensitive files exactly
  const blockedExact = [
    "/etc/passwd", "/etc/shadow", "/etc/hosts", "/etc/ssl",
    "/etc/ssh", "/etc/sudoers",
  ];

  for (const prefix of blockedPrefixes) {
    if (resolved.startsWith(prefix)) {
      return { safe: false, reason: `Path is in blocked system directory: ${prefix}` };
    }
  }
  for (const exact of blockedExact) {
    if (resolved === exact || resolved.startsWith(exact + "/")) {
      return { safe: false, reason: `Path is a sensitive system file: ${exact}` };
    }
  }

  // Block hidden files in home directory
  const home = Deno.env.get("HOME") ?? "/home";
  if (resolved.startsWith(home + "/.") && !resolved.includes(home + "/.config")) {
    // Allow .config but block .ssh, .gnupg, etc.
    const relHome = resolved.substring(home.length);
    if (relHome.match(/^\/\.(ssh|gnupg|aws|docker|kube|gcloud|azure)/)) {
      return { safe: false, reason: `Path is in sensitive hidden directory` };
    }
  }

  // Sandbox: restrict to project directory
  if (sandbox) {
    const normalizedCwd = cwd.endsWith("/") ? cwd.substring(0, cwd.length - 1) : cwd;
    if (!resolved.startsWith(normalizedCwd + "/") && resolved !== normalizedCwd) {
      return {
        safe: false,
        reason: `Path outside project directory. Sandbox restricts to: ${normalizedCwd}`,
      };
    }
  }

  return { safe: true };
}

// ─── Command Safety ───────────────────────────────────

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\b/, reason: "Recursive force delete (rm -rf)" },
  { pattern: /\brm\s+-r\b/, reason: "Recursive delete (rm -r)" },
  { pattern: /\bsudo\b/, reason: "Superuser execution (sudo)" },
  { pattern: /\bchmod\s+777\b/, reason: "World-writable permissions (chmod 777)" },
  { pattern: /\bchmod\s+-R\b/, reason: "Recursive permission change" },
  { pattern: /\bchown\b/, reason: "Ownership change (chown)" },
  { pattern: /\bmkfs\./, reason: "Filesystem format (mkfs)" },
  { pattern: /\bdd\s+if=/, reason: "Disk duplication (dd)" },
  { pattern: /\b>:.*\/dev\//, reason: "Writing to device files" },
  { pattern: /\bcurl.*\|\s*(ba)?sh\b/, reason: "Piping curl to shell" },
  { pattern: /\bwget.*\|\s*(ba)?sh\b/, reason: "Piping wget to shell" },
  { pattern: /\bgit\s+push\s+--force/, reason: "Force push to remote" },
  { pattern: /\bgit\s+push\s+-f\b/, reason: "Force push to remote" },
  { pattern: /\bdocker\s+rm\b/, reason: "Docker container/image removal" },
  { pattern: /\bdocker\s+system\s+prune\b/, reason: "Docker system prune" },
  { pattern: /\bshutdown\b/, reason: "System shutdown" },
  { pattern: /\breboot\b/, reason: "System reboot" },
  { pattern: /\bkill\s+-9\b/, reason: "Force kill process (kill -9)" },
  { pattern: /\bpkill\b/, reason: "Process kill by name (pkill)" },
  { pattern: /:\(\)\s*\{\s*:\s*\|:.*\};:/, reason: "Fork bomb detected" },
];

export function isCommandSafe(command: string): SafetyCheck {
  const trimmed = command.trim();

  // Block empty commands
  if (!trimmed) {
    return { safe: false, reason: "Empty command" };
  }

  // Check each dangerous pattern
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason };
    }
  }

  // Block commands that try to escape the sandbox
  if (trimmed.includes("$HOME") || trimmed.includes("$HOME")) {
    // Allow if it's just reading, not modifying
    if (/\brm\b|\bmv\b|\bcp\b.*\$HOME/.test(trimmed)) {
      return { safe: false, reason: "Modifying files in \$HOME" };
    }
  }

  return { safe: true };
}

// ─── Summarize safety for agent ────────────────────────

export function sandboxContext(cwd: string, sandbox: boolean): string {
  if (!sandbox) return "";
  return `\n\nSafety: Path sandbox is active. All file access is restricted to: ${cwd}. Sensitive system paths are blocked. Dangerous commands are detected and warned about.`;
}
