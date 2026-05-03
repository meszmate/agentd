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
import { Highlight, themes } from "prism-react-renderer";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import { CodeBlock, normalizeLanguage } from "@/components/code-block";

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
  output,
  outputOk,
}: {
  content: string;
  running?: boolean;
  className?: string;
  /**
   * The tool's response — typically `tool_result.preview` from the
   * helper stream. Rendered claude-code style: first 3 lines in a
   * compact monospace strip, with `+N more lines` if there's more
   * (clickable to toggle the rest).
   */
  output?: string | null;
  /** false ⇒ red dot (tool failed). true / undefined ⇒ neutral. */
  outputOk?: boolean;
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
  const [outputExpanded, setOutputExpanded] = useState(false);

  return (
    <div
      className={cn(
        "group font-mono text-[11.5px] text-ink-600 dark:text-ink-400 leading-snug",
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
              <ChevronDown className="h-2.5 w-2.5" />
            ) : (
              <ChevronRight className="h-2.5 w-2.5" />
            )}
          </button>
        )}
      </div>
      {showInlineCode && (
        <div className="mt-1">
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
        <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-ink-900/[0.06] bg-ink-900/[0.03] px-1.5 py-0.5 text-[10px] text-ink-500 dark:border-ink-50/[0.06] dark:bg-ink-50/[0.03] dark:text-ink-400">
          {parsed.detail}
        </pre>
      )}
      {output && (
        <ToolOutput
          text={output}
          ok={outputOk !== false}
          expanded={outputExpanded}
          onToggle={() => setOutputExpanded((v) => !v)}
          language={inferOutputLanguage(parsed)}
        />
      )}
    </div>
  );
}

/**
 * Claude-code-style output preview. Three lines visible by default
 * with a "+N lines" pill the operator can click to expand. Rendered
 * inline beneath the tool row, indented to match the icon column.
 *
 * Failed tools get a red dot + the same body so the operator can
 * eyeball errors without expanding.
 */
function ToolOutput({
  text,
  ok,
  expanded,
  onToggle,
  language,
}: {
  text: string;
  ok: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Optional language hint — when set, output is prism-highlighted. */
  language?: string;
}) {
  // Strip control chars + ANSI so the preview is readable. Trim any
  // trailing whitespace so blank tail-lines don't pad the preview.
  const cleaned = text
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/\s+$/, "");
  if (!cleaned) return null;
  const allLines = cleaned.split("\n");
  const previewLineCount = 3;
  const overflow = allLines.length - previewLineCount;
  const visible = expanded ? allLines : allLines.slice(0, previewLineCount);
  return (
    <div className="mt-1 flex items-stretch text-[11px] font-mono leading-snug">
      <span
        className={cn(
          "shrink-0 w-0.5 self-stretch rounded-full mr-2",
          ok
            ? "bg-ink-900/[0.08] dark:bg-ink-50/[0.08]"
            : "bg-red-500/60",
        )}
      />
      <div className="flex-1 min-w-0">
        {language ? (
          <HighlightedPre
            code={visible.join("\n")}
            language={language}
            tone={ok ? "ok" : "fail"}
          />
        ) : (
          <pre
            className={cn(
              "whitespace-pre-wrap break-words m-0",
              ok
                ? "text-ink-500 dark:text-ink-400"
                : "text-red-700 dark:text-red-300",
            )}
          >
            {visible.join("\n")}
          </pre>
        )}
        {overflow > 0 && (
          <button
            type="button"
            onClick={onToggle}
            className="mt-0.5 inline-flex items-center gap-1 text-[9.5px] uppercase tracking-[0.06em] text-ink-400 hover:text-ink-700 dark:text-ink-500 dark:hover:text-ink-200 transition-colors"
          >
            {expanded ? (
              <>
                <ChevronDown className="h-2.5 w-2.5" />
                hide {overflow} {overflow === 1 ? "line" : "lines"}
              </>
            ) : (
              <>
                <ChevronRight className="h-2.5 w-2.5" />
                +{overflow} {overflow === 1 ? "line" : "lines"}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Headerless prism-highlighted block — same theme as `<CodeBlock>`
 * but no chrome (no border, no header, no line numbers). Used inside
 * `<ToolOutput>` so the bash / file content preview gets proper
 * syntax highlighting without the heavy code-block frame.
 */
function HighlightedPre({
  code,
  language,
  tone,
}: {
  code: string;
  language: string;
  tone: "ok" | "fail";
}) {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";
  return (
    <Highlight
      code={code}
      language={normalizeLanguage(language)}
      theme={isDark ? themes.oneDark : themes.oneLight}
    >
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={cn(
            className,
            "whitespace-pre overflow-x-auto m-0 px-2 py-1 rounded",
            isDark ? "bg-ink-50/[0.035]" : "bg-ink-900/[0.035]",
            tone === "fail" && "text-red-700 dark:text-red-300",
            // Thin scrollbar so it doesn't eat vertical space when the
            // line overflows horizontally.
            "[&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5",
            "[&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-ink-900/15 dark:[&::-webkit-scrollbar-thumb]:bg-ink-50/15",
            "[&::-webkit-scrollbar-track]:bg-transparent",
          )}
          style={{
            ...style,
            background: "transparent",
            scrollbarWidth: "thin",
            scrollbarColor: "rgba(127,127,127,0.2) transparent",
          }}
        >
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line, key: i })}>
              {line.map((token, j) => (
                <span key={j} {...getTokenProps({ token, key: j })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}

/**
 * Pick a prism language for a tool's output preview based on what the
 * tool is. Read on a TS file → tsx; Bash → shell-like; Grep → no
 * highlighting (text). Returns undefined to opt out of highlighting.
 */
function inferOutputLanguage(parsed: ParsedTool): string | undefined {
  if (parsed.kind === "bash") return "bash";
  if (parsed.kind === "read" || parsed.kind === "edit" || parsed.kind === "write") {
    // detailLanguage is set by the parser when it recognized the
    // file extension. Reuse it for the output preview too.
    if (parsed.detailLanguage) return parsed.detailLanguage;
    if (parsed.detailFilename) return langFromPath(parsed.detailFilename);
    return undefined;
  }
  return undefined;
}

/**
 * Pair each `tool_use` event with the immediately-following
 * `tool_result` (if any). Mirrors how the helper protocol always
 * emits them in lockstep — each call followed by its response.
 *
 * Returns objects shaped for direct `<ToolLine>` use:
 *   `{ name, input, output, ok, running }`
 *
 * Pass `running=true` for the final pair when the agent is still
 * working so its row spins. Stable across `IdeaChatEvent` and
 * `IdeationEvent` since both have the same kind discriminators.
 */
export function pairToolEvents(
  events: ReadonlyArray<{
    kind: string;
    name?: string;
    input?: unknown;
    ok?: boolean;
    preview?: string;
  }>,
): Array<{
  name: string;
  input: unknown;
  output: string | null;
  ok: boolean;
  running: boolean;
}> {
  const out: Array<{
    name: string;
    input: unknown;
    output: string | null;
    ok: boolean;
    running: boolean;
  }> = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.kind !== "tool_use" || typeof ev.name !== "string") continue;
    const next = events[i + 1];
    const matched = next && next.kind === "tool_result" ? next : null;
    out.push({
      name: ev.name,
      input: ev.input,
      output: matched?.preview ?? null,
      ok: matched?.ok !== false,
      // The most recent tool_use without a paired result is "running".
      running: !matched && i === events.length - 1,
    });
  }
  return out;
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
