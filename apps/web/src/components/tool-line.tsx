import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Edit3,
  FileText,
  Globe,
  Loader2,
  Search,
  Terminal,
  Bot,
  ClipboardList,
  Folder,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/code-block";

/**
 * Compact one-line render for an agent tool call. Mirrors the realtime
 * feel of `claude-code` and `codex` — file paths, commands, hit counts
 * inline; raw blobs collapsed behind a chevron the operator can pop
 * open if they want details.
 *
 * Input: the persisted message string `"[call <Tool>] {jsonArgs}"`
 * (what `taskManager.handleEvent` writes for every `tool_call`).
 *
 * If `running` is set, shows a spinner instead of the tool icon — used
 * by the live in-flight indicator before the row gets persisted.
 */
export function ToolLine({
  content,
  running = false,
  className,
}: {
  content: string;
  running?: boolean;
  className?: string;
}) {
  const parsed = parseToolCall(content);
  const Icon = ICONS[parsed.kind] ?? Wrench;
  // Code-bearing tools render their detail inline (no chevron, always
  // visible) — claude-code feel. Other tools (Glob, Grep, Read,
  // WebFetch, Task) keep the compact one-liner.
  const showInlineCode = parsed.detail != null && parsed.detailLanguage != null;
  // Plain-text detail (e.g. Bash description, Task prompt) — kept
  // collapsible so it doesn't dominate.
  const [openText, setOpenText] = useState(false);
  const showTextToggle = parsed.detail != null && parsed.detailLanguage == null;

  return (
    <div
      className={cn(
        "group font-mono text-[11px] text-ink-600 dark:text-ink-400 leading-snug",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <span className="grid place-items-center size-4 mt-px shrink-0 text-ink-400 dark:text-ink-500">
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin text-ember-500" />
          ) : (
            <Icon className="h-3 w-3" />
          )}
        </span>
        <span className="font-semibold text-ink-700 dark:text-ink-200 shrink-0">
          {parsed.name}
        </span>
        {parsed.summary && (
          <>
            <span className="text-ink-300 dark:text-ink-600 shrink-0">·</span>
            <span className="truncate min-w-0 flex-1 text-ink-500 dark:text-ink-400">
              {parsed.summary}
            </span>
          </>
        )}
        {showTextToggle && (
          <button
            type="button"
            onClick={() => setOpenText((o) => !o)}
            className="shrink-0 inline-flex items-center text-ink-400 dark:text-ink-500 hover:text-ink-700 dark:hover:text-ink-200"
            title={openText ? "Hide details" : "Show details"}
          >
            {openText ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        )}
      </div>
      {showInlineCode && (
        <div className="mt-1.5">
          <CodeBlock
            code={parsed.detail!}
            language={parsed.detailLanguage}
            filename={parsed.detailFilename}
            showLineNumbers={parsed.detailLanguage !== "bash"}
            diffMarks={parsed.detailDiffMarks}
          />
        </div>
      )}
      {showTextToggle && openText && parsed.detail && (
        <pre className="mt-1 ml-6 whitespace-pre-wrap break-words rounded border border-ink-900/[0.06] bg-ink-900/[0.03] px-2 py-1 text-[10.5px] text-ink-500 dark:border-ink-50/[0.06] dark:bg-ink-50/[0.03] dark:text-ink-400">
          {parsed.detail}
        </pre>
      )}
    </div>
  );
}

type ToolKind =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "search"
  | "glob"
  | "web"
  | "subagent"
  | "todo"
  | "other";

const ICONS: Record<ToolKind, React.ComponentType<{ className?: string }>> = {
  read: FileText,
  write: FileText,
  edit: Edit3,
  bash: Terminal,
  search: Search,
  glob: Folder,
  web: Globe,
  subagent: Bot,
  todo: ClipboardList,
  other: Wrench,
};

interface ParsedTool {
  name: string;
  kind: ToolKind;
  summary: string;
  detail: string | null;
  /** When set, render `detail` as a syntax-highlighted CodeBlock. */
  detailLanguage?: string;
  /** Optional path label shown in the CodeBlock header. */
  detailFilename?: string;
  /**
   * Per-line diff markers. When present, each line of `detail` gets
   * a green/red wash based on its mark — and the file's native
   * language still colors the code itself (no plain-blue diff).
   */
  detailDiffMarks?: Array<"+" | "-" | " " | null>;
}

/**
 * Pull the tool name + the most informative single arg into a one-line
 * summary. Anything verbose (whole file contents, full edit bodies,
 * stringified TodoWrite arrays) gets stuffed into `detail` for the
 * collapsible disclosure — never inline.
 */
function parseToolCall(content: string): ParsedTool {
  const m = content.match(/^\[call ([^\]]+)\]\s*([\s\S]*)$/);
  if (!m) {
    return { name: "tool", kind: "other", summary: content.slice(0, 120), detail: null };
  }
  const name = m[1]!.trim();
  const argsRaw = m[2]!.trim();
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsRaw);
  } catch {
    return { name, kind: classify(name), summary: trimOneLine(argsRaw, 100), detail: null };
  }

  const kind = classify(name);
  const get = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };

  // Per-tool summary extraction. Keep the line short — file path,
  // command first line, search query, etc. Detail holds the rest.
  switch (name) {
    case "Read": {
      const path = get("file_path", "path") ?? "?";
      const offset =
        typeof args.offset === "number" ? ` @${args.offset}` : "";
      const limit =
        typeof args.limit === "number" ? ` ×${args.limit}` : "";
      return { name, kind, summary: `${shortPath(path)}${offset}${limit}`, detail: null };
    }
    case "Write": {
      const path = get("file_path", "path") ?? "?";
      const content = get("content");
      const lines = content ? content.split("\n").length : 0;
      return {
        name,
        kind,
        summary: `${shortPath(path)}${lines ? ` (${lines} lines)` : ""}`,
        detail: content ?? null,
        detailLanguage: content ? langFromPath(path) : undefined,
        detailFilename: shortPath(path),
      };
    }
    case "Edit":
    case "MultiEdit": {
      const path = get("file_path", "path") ?? "?";
      const oldStr = get("old_string");
      const newStr = get("new_string");
      const replaceAll = args.replace_all === true ? " (all)" : "";
      const oldLines = oldStr ? oldStr.split("\n") : [];
      const newLines = newStr ? newStr.split("\n") : [];
      // Build raw code (no +/- prefixes) so prism highlights it in
      // the file's native language. The diffMarks array carries the
      // +/- info per line, used by CodeBlock to wash the row green/red.
      const detail =
        oldLines.length + newLines.length > 0
          ? [...oldLines, ...newLines].join("\n")
          : null;
      const detailDiffMarks: Array<"+" | "-"> | undefined = detail
        ? [
            ...oldLines.map(() => "-" as const),
            ...newLines.map(() => "+" as const),
          ]
        : undefined;
      return {
        name,
        kind,
        summary: `${shortPath(path)}${replaceAll}${
          oldLines.length || newLines.length
            ? ` +${newLines.length} -${oldLines.length}`
            : ""
        }`,
        detail,
        detailLanguage: detail ? langFromPath(path) : undefined,
        detailFilename: shortPath(path),
        detailDiffMarks,
      };
    }
    case "Bash": {
      const cmd = get("command") ?? "";
      const desc = get("description");
      // Only show the bash code block when it adds value: multi-line
      // scripts, or commands the summary had to truncate. For a short
      // single-line command the summary already shows everything.
      const isMultiline = cmd.includes("\n");
      const wasTruncated = cmd.length > 100;
      const showBlock = cmd && (isMultiline || wasTruncated);
      return {
        name,
        kind,
        summary: trimOneLine(cmd, 100),
        detail: showBlock ? cmd : desc && desc !== cmd ? desc : null,
        detailLanguage: showBlock ? "bash" : undefined,
      };
    }
    case "Glob": {
      const pattern = get("pattern") ?? "?";
      return { name, kind, summary: pattern, detail: null };
    }
    case "Grep": {
      const pattern = get("pattern") ?? "?";
      const path = get("path");
      return {
        name,
        kind,
        summary: `${pattern}${path ? ` in ${shortPath(path)}` : ""}`,
        detail: null,
      };
    }
    case "WebFetch":
      return { name, kind, summary: get("url") ?? "?", detail: get("prompt") ?? null };
    case "WebSearch":
      return { name, kind, summary: get("query") ?? "?", detail: null };
    case "Task": {
      const sub = get("subagent_type", "agent");
      const desc = get("description");
      return {
        name,
        kind,
        summary: [sub, desc].filter(Boolean).join(" · ") || "subagent",
        detail: get("prompt") ?? null,
      };
    }
    case "TodoWrite":
    case "update_plan": {
      const items =
        Array.isArray(args.todos) && args.todos.length > 0
          ? (args.todos as unknown[]).length
          : Array.isArray(args.plan)
            ? (args.plan as unknown[]).length
            : 0;
      return {
        name,
        kind,
        summary: `${items} item${items === 1 ? "" : "s"}`,
        detail: null,
      };
    }
    case "NotebookEdit":
      return {
        name,
        kind: "edit",
        summary: shortPath(get("notebook_path", "path") ?? "?"),
        detail: null,
      };
    default: {
      // Unknown tool — show the first key/value pair we find as a hint,
      // stash the full args in detail.
      const firstKv = Object.entries(args).find(
        ([, v]) => typeof v === "string" || typeof v === "number",
      );
      return {
        name,
        kind,
        summary: firstKv ? `${firstKv[0]}: ${trimOneLine(String(firstKv[1]), 80)}` : "",
        detail: argsRaw.length > 60 ? argsRaw : null,
      };
    }
  }
}

function classify(name: string): ToolKind {
  if (name === "Read") return "read";
  if (name === "Write") return "write";
  if (name === "Edit" || name === "MultiEdit" || name === "NotebookEdit")
    return "edit";
  if (name === "Bash") return "bash";
  if (name === "Grep") return "search";
  if (name === "Glob") return "glob";
  if (name === "WebFetch" || name === "WebSearch") return "web";
  if (name === "Task") return "subagent";
  if (name === "TodoWrite" || name === "update_plan") return "todo";
  return "other";
}

/** Trim a string to one line, clamp to N chars, append ellipsis. */
function trimOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** Show only the last 2-3 path segments so wide repos stay readable. */
function shortPath(p: string): string {
  if (!p) return "?";
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return parts.slice(-3).join("/");
}

/** Best-effort filename → prism language. Falls through to "tsx". */
function langFromPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "tsx";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "jsx";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "rb":
      return "ruby";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "yml":
    case "yaml":
      return "yaml";
    case "json":
    case "jsonc":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "html":
    case "htm":
      return "markup";
    case "css":
      return "css";
    case "sql":
      return "sql";
    case "diff":
    case "patch":
      return "diff";
    default:
      return "tsx";
  }
}
