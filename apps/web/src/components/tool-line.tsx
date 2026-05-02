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
  const [open, setOpen] = useState(false);
  const Icon = ICONS[parsed.kind] ?? Wrench;

  return (
    <div
      className={cn(
        "group flex items-start gap-2 font-mono text-[11px] text-ink-600 dark:text-ink-400 leading-snug",
        className,
      )}
    >
      <span className="grid place-items-center size-4 mt-px shrink-0 text-ink-400 dark:text-ink-500">
        {running ? (
          <Loader2 className="h-3 w-3 animate-spin text-ember-500" />
        ) : (
          <Icon className="h-3 w-3" />
        )}
      </span>
      <span className="font-medium text-ink-700 dark:text-ink-200 shrink-0">
        {parsed.name}
      </span>
      {parsed.summary && (
        <span className="truncate min-w-0 flex-1 text-ink-500 dark:text-ink-400">
          {parsed.summary}
        </span>
      )}
      {parsed.detail && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 inline-flex items-center text-ink-400 dark:text-ink-500 hover:text-ink-700 dark:hover:text-ink-200"
          title={open ? "Hide details" : "Show details"}
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
      )}
      {open && parsed.detail && (
        <pre className="basis-full mt-1 ml-6 whitespace-pre-wrap break-words rounded border border-ink-900/[0.06] bg-ink-900/[0.03] px-2 py-1 text-[10.5px] text-ink-500 dark:border-ink-50/[0.06] dark:bg-ink-50/[0.03] dark:text-ink-400">
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
        detail: null,
      };
    }
    case "Edit":
    case "MultiEdit": {
      const path = get("file_path", "path") ?? "?";
      const oldStr = get("old_string");
      const newStr = get("new_string");
      const replaceAll = args.replace_all === true ? " (all)" : "";
      // Rough hunk size for at-a-glance flavor.
      const adds = newStr ? newStr.split("\n").length : 0;
      const dels = oldStr ? oldStr.split("\n").length : 0;
      return {
        name,
        kind,
        summary: `${shortPath(path)}${replaceAll}${
          adds || dels ? ` +${adds} -${dels}` : ""
        }`,
        detail: null,
      };
    }
    case "Bash": {
      const cmd = get("command") ?? "";
      const desc = get("description");
      return {
        name,
        kind,
        summary: trimOneLine(cmd, 100),
        detail: desc && desc !== cmd ? desc : null,
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
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-3).join("/");
}
