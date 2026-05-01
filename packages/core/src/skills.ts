/**
 * Skills — filesystem-backed prompts that can be activated per-task.
 *
 * A skill is a directory containing a SKILL.md file:
 *
 *   <root>/skills/review-pr/SKILL.md
 *   <root>/skills/review-pr/scripts/run.sh   (optional assets)
 *
 * SKILL.md format:
 *
 *   ---
 *   name: review-pr
 *   displayName: PR review
 *   description: Reviews pull requests and posts inline comments.
 *   ---
 *   You are a careful PR reviewer. When invoked …
 *
 * Frontmatter is parsed as plain key: value lines (no full YAML lib).
 * Anything after the closing `---` is the body that gets appended to the
 * agent's system prompt when the skill is activated for a task.
 *
 * Sources, in priority order (later sources override earlier slugs):
 *   - "claude" : ~/.claude/skills/<name>/SKILL.md     (read-only)
 *   - "codex"  : ~/.codex/skills/<name>/SKILL.md      (read-only)
 *   - "global" : <agentdRoot>/skills/<name>/SKILL.md  (per-server, writable)
 *   - "local"  : <repoPath>/.agents/skills/<name>/SKILL.md (per-project, writable)
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, relative, resolve } from "node:path";

export type SkillScope = "global" | "local" | "claude" | "codex";

export interface Skill {
  name: string;
  scope: SkillScope;
  path: string;
  displayName: string | undefined;
  description: string | undefined;
  enabled: boolean;
  body: string;
  metadata: Record<string, unknown>;
  slug: string;
  writable: boolean;
}

export interface SkillsRoots {
  root: string;
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

function parseFrontmatter(raw: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { metadata: {}, body: raw };
  const head = m[1] ?? "";
  const body = raw.slice(m[0].length);
  const metadata: Record<string, unknown> = {};
  for (const line of head.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value: unknown = trimmed.slice(idx + 1).trim();
    if (typeof value === "string") {
      const v = value;
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        value = v.slice(1, -1);
      } else if (v === "true") value = true;
      else if (v === "false") value = false;
      else if (/^-?\d+$/.test(v)) value = Number(v);
    }
    metadata[key] = value;
  }
  return { metadata, body };
}

function skillRootFor(scope: SkillScope, opts: { agentdRoot: string; repoPath?: string }): string | null {
  switch (scope) {
    case "claude":
      return join(homedir(), ".claude", "skills");
    case "codex":
      return join(homedir(), ".codex", "skills");
    case "global":
      return join(opts.agentdRoot, "skills");
    case "local":
      return opts.repoPath ? join(opts.repoPath, ".agents", "skills") : null;
  }
}

function isWritableScope(scope: SkillScope): boolean {
  return scope === "global" || scope === "local";
}

function listScope(
  scope: SkillScope,
  opts: { agentdRoot: string; repoPath?: string },
): Skill[] {
  const root = skillRootFor(scope, opts);
  if (!root || !existsSync(root)) return [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const slug of dirs) {
    if (slug.startsWith(".")) continue;
    const dirPath = join(root, slug);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(dirPath);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const skillFile = join(dirPath, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let raw: string;
    try {
      raw = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    const { metadata, body } = parseFrontmatter(raw);
    const name = (metadata.name as string | undefined) ?? slug;
    const displayName = metadata.displayName as string | undefined;
    const description = metadata.description as string | undefined;
    const enabled = metadata.enabled === false ? false : true;
    out.push({
      name,
      scope,
      path: skillFile,
      displayName,
      description,
      enabled,
      body: body.trim(),
      metadata,
      slug,
      writable: isWritableScope(scope),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function listAllSkills(opts: {
  agentdRoot: string;
  repoPath?: string;
}): Skill[] {
  const all = [
    ...listScope("local", opts),
    ...listScope("global", opts),
    ...listScope("claude", opts),
    ...listScope("codex", opts),
  ];
  return all;
}

export function findSkill(
  id: string,
  opts: { agentdRoot: string; repoPath?: string },
): Skill | null {
  const [scope, slug] = id.split(":");
  if (!scope || !slug) return null;
  if (
    scope !== "global" &&
    scope !== "local" &&
    scope !== "claude" &&
    scope !== "codex"
  )
    return null;
  const list = listScope(scope as SkillScope, opts);
  return list.find((s) => s.slug === slug) ?? null;
}

export interface CreateSkillInput {
  scope: "global" | "local";
  slug: string;
  displayName?: string;
  description?: string;
  body?: string;
}

export function createSkill(
  input: CreateSkillInput,
  opts: { agentdRoot: string; repoPath?: string },
): Skill {
  const root = skillRootFor(input.scope, opts);
  if (!root) {
    throw new Error(`scope ${input.scope} requires a repo path`);
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(input.slug)) {
    throw new Error("slug must be a-z, 0-9, dashes or underscores");
  }
  const dir = join(root, input.slug);
  if (existsSync(join(dir, "SKILL.md"))) {
    throw new Error(`skill ${input.scope}:${input.slug} already exists`);
  }
  mkdirSync(dir, { recursive: true });
  const md = renderSkillFile({
    name: input.slug,
    displayName: input.displayName,
    description: input.description,
    body: input.body ?? "",
  });
  writeFileSync(join(dir, "SKILL.md"), md, "utf8");
  return findSkill(`${input.scope}:${input.slug}`, opts)!;
}

export interface UpdateSkillInput {
  displayName?: string;
  description?: string;
  body?: string;
}

export function updateSkill(
  id: string,
  patch: UpdateSkillInput,
  opts: { agentdRoot: string; repoPath?: string },
): Skill {
  const cur = findSkill(id, opts);
  if (!cur) throw new Error(`skill not found: ${id}`);
  if (!cur.writable) throw new Error(`skill is read-only: ${id}`);
  const md = renderSkillFile({
    name: cur.slug,
    displayName:
      patch.displayName ?? cur.displayName ?? undefined,
    description:
      patch.description ?? cur.description ?? undefined,
    body: patch.body ?? cur.body,
  });
  writeFileSync(cur.path, md, "utf8");
  return findSkill(id, opts)!;
}

export function deleteSkill(
  id: string,
  opts: { agentdRoot: string; repoPath?: string },
): void {
  const cur = findSkill(id, opts);
  if (!cur) return;
  if (!cur.writable) throw new Error(`skill is read-only: ${id}`);
  // Remove the entire skill directory (slug-named).
  const skillDir = cur.path.replace(/\/SKILL\.md$/, "");
  rmSync(skillDir, { recursive: true, force: true });
}

interface RenderInput {
  name: string;
  displayName?: string | undefined;
  description?: string | undefined;
  body: string;
}
function renderSkillFile(input: RenderInput): string {
  const lines = ["---"];
  lines.push(`name: ${input.name}`);
  if (input.displayName) lines.push(`displayName: ${input.displayName}`);
  if (input.description) lines.push(`description: ${input.description}`);
  lines.push("---");
  lines.push("");
  lines.push(input.body.trim());
  lines.push("");
  return lines.join("\n");
}

/** Roughly: 1 token ≈ 4 characters of English text. Good enough for budgeting. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Lower number = drops first when the budget is tight. */
function scopePriority(scope: SkillScope): number {
  switch (scope) {
    case "claude":
      return 0;
    case "codex":
      return 0;
    case "global":
      return 1;
    case "local":
      return 2;
  }
}

export interface RenderedPrompt {
  text: string;
  /** Skill ids that didn't make it into `text` because of the budget. */
  trimmed: string[];
  /** ids that did make it, in render order. */
  kept: string[];
  /** Approximate token usage of the rendered text. */
  tokens: number;
  /** Budget that was applied (Infinity means no budget). */
  budget: number;
}

/**
 * Build a system-prompt suffix from a list of skill ids. The result is the
 * merged body of the matching skills, ready to append to the agent's prompt.
 * Skills that don't resolve are silently skipped.
 *
 * If `maxTokens` is finite, skills are dropped from the lowest priority
 * scope first (claude/codex before global before local) until the estimate
 * is under budget. Returns the rendered text plus trim metadata so callers
 * can surface what didn't make it.
 */
export function renderSkillsBudgeted(
  ids: string[],
  opts: { agentdRoot: string; repoPath?: string; maxTokens?: number },
): RenderedPrompt {
  const budget = opts.maxTokens ?? Number.POSITIVE_INFINITY;
  const resolved: { id: string; skill: Skill; rendered: string; tokens: number }[] = [];
  for (const id of ids) {
    const s = findSkill(id, opts);
    if (!s || !s.enabled) continue;
    const rendered = `# Skill: ${s.displayName ?? s.name}\n\n${s.body.trim()}`;
    resolved.push({
      id: `${s.scope}:${s.slug}`,
      skill: s,
      rendered,
      tokens: approxTokens(rendered),
    });
  }

  // Drop lowest-priority items first until under budget.
  const trimmed: string[] = [];
  let total = resolved.reduce((s, r) => s + r.tokens, 0);
  if (Number.isFinite(budget)) {
    const queue = resolved
      .map((r, idx) => ({ ...r, idx }))
      .sort((a, b) => {
        const ap = scopePriority(a.skill.scope);
        const bp = scopePriority(b.skill.scope);
        if (ap !== bp) return ap - bp;
        // Within a scope, drop the largest first.
        return b.tokens - a.tokens;
      });
    while (total > budget && queue.length > 0) {
      const drop = queue.shift()!;
      trimmed.push(drop.id);
      total -= drop.tokens;
      const live = resolved.findIndex((r) => r.id === drop.id);
      if (live >= 0) resolved.splice(live, 1);
    }
  }

  const kept = resolved.map((r) => r.id);
  const text = resolved.map((r) => r.rendered).join("\n\n---\n\n");
  return { text, trimmed, kept, tokens: total, budget };
}

/** Backwards-compat wrapper used by older callers (no budget). */
export function renderSkillsForPrompt(
  ids: string[],
  opts: { agentdRoot: string; repoPath?: string },
): string {
  return renderSkillsBudgeted(ids, opts).text;
}

export interface RenderedCatalog {
  text: string;
  /** Resolved skills in catalog order. */
  entries: {
    id: string;
    name: string;
    displayName: string | undefined;
    description: string | undefined;
    skillFile: string;
    skillDir: string;
  }[];
}

/**
 * Build a *catalog* of available skills — name, description, and absolute
 * path to each SKILL.md — instead of pasting the full bodies into the
 * system prompt.
 *
 * The agent reads a SKILL.md when the catalog entry hints it might be
 * relevant, then reads any bundled scripts/references the same way.
 * This is the progressive-disclosure pattern Claude Code uses for
 * `~/.claude/skills/`: at start, ~50 tokens per skill; only the chosen
 * skill's body lands in context. Cheaper, and the agent only commits
 * to a skill when it's actually relevant.
 */
export function renderSkillsCatalog(
  ids: string[],
  opts: { agentdRoot: string; repoPath?: string },
): RenderedCatalog {
  const entries: RenderedCatalog["entries"] = [];
  for (const id of ids) {
    const s = findSkill(id, opts);
    if (!s || !s.enabled) continue;
    const skillDir = s.path.replace(/\/SKILL\.md$/, "");
    entries.push({
      id: `${s.scope}:${s.slug}`,
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      skillFile: s.path,
      skillDir,
    });
  }

  if (entries.length === 0) {
    return { text: "", entries };
  }

  const lines: string[] = [];
  lines.push("# Skills available for this task");
  lines.push("");
  lines.push(
    "These are reusable instruction packs. Each entry tells you the file " +
      "to read for the full skill body, and the directory containing any " +
      "bundled helper scripts or reference docs.",
  );
  lines.push("");
  lines.push(
    "**When a task touches a skill's domain, read its SKILL.md first.** " +
      "Don't load every skill — only the ones that matter for this task. " +
      "After reading SKILL.md, you can list the skill directory and read " +
      "any scripts/ or references/ files it points to.",
  );
  lines.push("");
  for (const e of entries) {
    const display = e.displayName ?? e.name;
    const desc = e.description ?? "(no description)";
    lines.push(`- **${display}** (\`${e.id}\`) — ${desc}`);
    lines.push(`  - Read: \`${e.skillFile}\``);
    lines.push(`  - Bundle dir: \`${e.skillDir}\``);
  }
  return { text: lines.join("\n"), entries };
}

// ── Skill file management ──────────────────────────────────────────
//
// Skills are directories: a SKILL.md plus optional scripts/ + references/
// + arbitrary other files. The functions below let the web UI manage that
// directory tree directly. All paths are resolved through the skill dir
// and validated to prevent escape (e.g. "../../etc/passwd").

export interface SkillFileNode {
  /** Path relative to the skill dir, posix-style. "" for root. */
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

const SKIPPED_NAMES = new Set([".git", "node_modules", "__pycache__"]);
const MAX_TREE_ENTRIES = 500;

function skillDirOf(skill: Skill): string {
  return skill.path.replace(/\/SKILL\.md$/, "");
}

/** Resolve a relative path inside the skill dir, refusing escapes. */
function resolveInside(skill: Skill, rel: string): string {
  const dir = skillDirOf(skill);
  const joined = normalize(join(dir, rel));
  const r = relative(dir, joined);
  if (r === "..") throw new Error("path escapes skill directory");
  if (r.startsWith("../") || r.startsWith("..\\")) {
    throw new Error("path escapes skill directory");
  }
  if (resolve(joined) === resolve(dir) && rel === "") return joined;
  return joined;
}

export function listSkillFiles(
  id: string,
  opts: { agentdRoot: string; repoPath?: string },
): SkillFileNode[] {
  const skill = findSkill(id, opts);
  if (!skill) throw new Error(`skill not found: ${id}`);
  const root = skillDirOf(skill);
  const out: SkillFileNode[] = [];
  const walk = (abs: string, rel: string): void => {
    if (out.length >= MAX_TREE_ENTRIES) return;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    entries.sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      if (SKIPPED_NAMES.has(name)) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(childAbs);
      } catch {
        continue;
      }
      out.push({
        path: childRel,
        name,
        isDir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtimeMs,
      });
      if (st.isDirectory()) walk(childAbs, childRel);
    }
  };
  walk(root, "");
  return out;
}

const MAX_FILE_BYTES = 1_000_000;

export function readSkillFile(
  id: string,
  relPath: string,
  opts: { agentdRoot: string; repoPath?: string },
): { content: string; size: number; binary: boolean } {
  const skill = findSkill(id, opts);
  if (!skill) throw new Error(`skill not found: ${id}`);
  const abs = resolveInside(skill, relPath);
  if (!existsSync(abs)) throw new Error("file not found");
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error("path is a directory");
  if (st.size > MAX_FILE_BYTES) {
    return { content: "", size: st.size, binary: true };
  }
  let content: string;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    return { content: "", size: st.size, binary: true };
  }
  return { content, size: st.size, binary: false };
}

export function writeSkillFile(
  id: string,
  relPath: string,
  content: string,
  opts: { agentdRoot: string; repoPath?: string },
): SkillFileNode {
  const skill = findSkill(id, opts);
  if (!skill) throw new Error(`skill not found: ${id}`);
  if (!skill.writable) throw new Error(`skill is read-only: ${id}`);
  if (!relPath.trim()) throw new Error("path required");
  // SKILL.md is owned by updateSkill, redirect callers there to keep the
  // frontmatter intact.
  if (relPath === "SKILL.md") {
    throw new Error("use updateSkill for SKILL.md edits");
  }
  const abs = resolveInside(skill, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  const st = statSync(abs);
  return {
    path: relPath,
    name: relPath.split("/").pop() ?? relPath,
    isDir: false,
    size: st.size,
    mtime: st.mtimeMs,
  };
}

export function deleteSkillFile(
  id: string,
  relPath: string,
  opts: { agentdRoot: string; repoPath?: string },
): void {
  const skill = findSkill(id, opts);
  if (!skill) throw new Error(`skill not found: ${id}`);
  if (!skill.writable) throw new Error(`skill is read-only: ${id}`);
  if (relPath === "SKILL.md" || relPath === "") {
    throw new Error("cannot delete the skill itself this way; use deleteSkill");
  }
  const abs = resolveInside(skill, relPath);
  if (!existsSync(abs)) return;
  const st = statSync(abs);
  if (st.isDirectory()) {
    rmSync(abs, { recursive: true, force: true });
  } else {
    unlinkSync(abs);
  }
}

export function skillDirPath(
  id: string,
  opts: { agentdRoot: string; repoPath?: string },
): string {
  const skill = findSkill(id, opts);
  if (!skill) throw new Error(`skill not found: ${id}`);
  return skillDirOf(skill);
}

