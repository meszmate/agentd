/**
 * Repo-context catalog — small system-prompt suffix that points the agent
 * at high-signal files inside the worktree it's about to work on. Same
 * progressive-disclosure idea as skills: don't paste the contents, just
 * tell the agent what exists and let it read what's relevant.
 *
 * The agent already has Read access to its cwd (the worktree), so all
 * the catalog needs is *names* — relative paths plus a one-liner saying
 * what to use them for. Sections are emitted only when the corresponding
 * files actually exist; an empty repo produces an empty string.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RepoContextEntry {
  /** Path relative to the worktree (forward-slash). */
  relPath: string;
  /** What this file is for, in agent-facing language. */
  hint: string;
}

export interface RepoContextSection {
  /** "conventions" | "toolchain" | "services" */
  key: "conventions" | "toolchain" | "services";
  title: string;
  /** Sentence that explains the section to the agent. */
  intro: string;
  entries: RepoContextEntry[];
}

export interface RenderedRepoContext {
  text: string;
  sections: RepoContextSection[];
}

const CONVENTION_DOCS: { rel: string; hint: string }[] = [
  {
    rel: "CLAUDE.md",
    hint: "operator's project notes — read this first if you're going to write code or commit",
  },
  {
    rel: "AGENTS.md",
    hint: "agent-facing project notes (alternative to CLAUDE.md)",
  },
  {
    rel: ".agents/INSTRUCTIONS.md",
    hint: "agentd-flavoured project instructions (highest priority of the three)",
  },
  {
    rel: "CONTRIBUTING.md",
    hint: "contributor conventions — code style, branching, PR template",
  },
];

const TOOLCHAIN_FILES: { rel: string; hint: string }[] = [
  { rel: ".tool-versions", hint: "asdf/mise — pinned language versions" },
  { rel: ".mise.toml", hint: "mise — language + tool versions" },
  { rel: "mise.toml", hint: "mise — language + tool versions" },
  { rel: ".nvmrc", hint: "Node version pin (use this `node`, not the system one)" },
  { rel: ".python-version", hint: "pyenv — Python version pin" },
  { rel: "rust-toolchain", hint: "rustup — Rust toolchain pin" },
  { rel: "rust-toolchain.toml", hint: "rustup — Rust toolchain pin" },
  { rel: ".ruby-version", hint: "rbenv/asdf — Ruby version pin" },
  { rel: ".envrc", hint: "direnv — env vars + PATH for this project (run `direnv allow` once)" },
  { rel: "package.json", hint: "Node project manifest — `engines` may pin Node/pnpm; `scripts` lists tasks" },
  { rel: "pyproject.toml", hint: "Python project manifest — has tool config + deps" },
  { rel: "Cargo.toml", hint: "Rust project manifest" },
  { rel: "go.mod", hint: "Go module — Go version is in the first line" },
  { rel: "Gemfile", hint: "Ruby gems — `bundle install`" },
  { rel: "flake.nix", hint: "Nix flake — `nix develop` for the dev env" },
  { rel: "shell.nix", hint: "Nix dev shell — `nix-shell` to enter" },
];

const SERVICE_FILES: { rel: string; hint: string }[] = [
  {
    rel: "docker-compose.yml",
    hint: "service stack — `docker compose up -d` brings up dependencies",
  },
  {
    rel: "docker-compose.yaml",
    hint: "service stack — `docker compose up -d` brings up dependencies",
  },
  {
    rel: "compose.yml",
    hint: "service stack — `docker compose up -d` brings up dependencies",
  },
  {
    rel: "compose.yaml",
    hint: "service stack — `docker compose up -d` brings up dependencies",
  },
  {
    rel: "Dockerfile",
    hint: "container build recipe for this project",
  },
  {
    rel: "Procfile",
    hint: "process types — `foreman start` or `honcho start` boots them",
  },
  {
    rel: "Makefile",
    hint: "common tasks — try `make help` for a list",
  },
  {
    rel: "justfile",
    hint: "task runner — `just --list` shows available recipes",
  },
];

function fileExists(root: string, rel: string): boolean {
  try {
    const p = join(root, rel);
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function readSnippet(
  root: string,
  rel: string,
  maxBytes: number,
): string | null {
  try {
    const p = join(root, rel);
    if (!existsSync(p)) return null;
    const buf = readFileSync(p, "utf8");
    if (buf.length <= maxBytes) return buf;
    return buf.slice(0, maxBytes);
  } catch {
    return null;
  }
}

/**
 * Returns first-line of go.mod ("go 1.22") or `engines` from package.json
 * to enrich the toolchain section. Best-effort; failures degrade to the
 * file's existence note alone.
 */
function enrichToolchainHint(
  root: string,
  rel: string,
  baseHint: string,
): string {
  if (rel === "package.json") {
    const txt = readSnippet(root, rel, 4096);
    if (!txt) return baseHint;
    try {
      const obj = JSON.parse(txt) as { engines?: Record<string, string> };
      const eng = obj.engines;
      if (eng && Object.keys(eng).length > 0) {
        const pairs = Object.entries(eng)
          .map(([k, v]) => `${k}@${v}`)
          .join(", ");
        return `${baseHint} (engines: ${pairs})`;
      }
    } catch {
      // not parseable — fall through
    }
    return baseHint;
  }
  if (rel === "go.mod") {
    const txt = readSnippet(root, rel, 256);
    if (!txt) return baseHint;
    const m = /^\s*go\s+([0-9.]+)/m.exec(txt);
    if (m) return `${baseHint.split(" — ")[0]} — Go ${m[1]}`;
    return baseHint;
  }
  if (rel === ".nvmrc") {
    const txt = readSnippet(root, rel, 64);
    if (!txt) return baseHint;
    const v = txt.trim();
    if (v) return `${baseHint} (Node ${v})`;
    return baseHint;
  }
  return baseHint;
}

export function renderRepoContext(opts: {
  worktreePath: string;
}): RenderedRepoContext {
  const root = opts.worktreePath;

  const conventions: RepoContextEntry[] = [];
  for (const { rel, hint } of CONVENTION_DOCS) {
    if (fileExists(root, rel)) conventions.push({ relPath: rel, hint });
  }

  const toolchain: RepoContextEntry[] = [];
  for (const { rel, hint } of TOOLCHAIN_FILES) {
    if (fileExists(root, rel)) {
      toolchain.push({ relPath: rel, hint: enrichToolchainHint(root, rel, hint) });
    }
  }

  const services: RepoContextEntry[] = [];
  for (const { rel, hint } of SERVICE_FILES) {
    if (fileExists(root, rel)) services.push({ relPath: rel, hint });
  }

  const sections: RepoContextSection[] = [];
  if (conventions.length > 0) {
    sections.push({
      key: "conventions",
      title: "Project conventions",
      intro:
        "Read these first — they explain how the operator wants this project handled.",
      entries: conventions,
    });
  }
  if (toolchain.length > 0) {
    sections.push({
      key: "toolchain",
      title: "Toolchain pins",
      intro:
        "This project pins specific language / tool versions. Use them, not the system defaults.",
      entries: toolchain,
    });
  }
  if (services.length > 0) {
    sections.push({
      key: "services",
      title: "Service stack & tasks",
      intro:
        "Files describing how to bring services up and run common tasks. Prefer existing recipes over inventing your own.",
      entries: services,
    });
  }

  if (sections.length === 0) {
    return { text: "", sections };
  }

  const lines: string[] = [];
  lines.push("# Repo context");
  lines.push("");
  lines.push(
    "These files exist in the worktree. They are short, high-signal, and cost nothing to Read on demand. Only commit to one when it's relevant to what's being asked.",
  );
  for (const s of sections) {
    lines.push("");
    lines.push(`## ${s.title}`);
    lines.push("");
    lines.push(s.intro);
    lines.push("");
    for (const e of s.entries) {
      lines.push(`- \`${e.relPath}\` — ${e.hint}`);
    }
  }
  return { text: lines.join("\n"), sections };
}
