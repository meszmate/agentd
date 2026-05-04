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
import {
  EditDiffPreview,
  type EditPreviewPayload,
} from "@/components/structured-diff";

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
  taskId,
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
  /**
   * Task whose worktree the tool ran in. When set, Edit/MultiEdit/
   * Write rows lazy-fetch the file via `useFile(taskId, path)` so
   * the synthesized diff includes 3 lines of context above/below the
   * change (matching claude-code's terminal). Without it the diff
   * still renders, just without surrounding context.
   */
  taskId?: string;
}) {
  const parsed = parseToolCall(content);
  const Icon = ICONS[parsed.kind] ?? Wrench;
  // Code-bearing tools render their detail inline (no chevron, always
  // visible) — claude-code feel. Other tools (Glob, Grep, Read,
  // WebFetch, Task) keep the compact one-liner.
  const showInlineCode = parsed.detail != null && parsed.detailLanguage != null;
  const showInlineDiff = parsed.editPreview != null;
  // Plain-text detail (e.g. Bash description, Task prompt) — kept
  // collapsible so it doesn't dominate.
  const [openText, setOpenText] = useState(false);
  const showTextToggle = parsed.detail != null && parsed.detailLanguage == null;
  const [outputExpanded, setOutputExpanded] = useState(false);

  // Status glyph at the start of the row — claude-code uses a ●
  // dot. Color carries semantics: ember = running, emerald = ok,
  // red = failed, neutral when no result yet (shouldn't render).
  const statusGlyph = running ? (
    <Loader2 className="h-3 w-3 animate-spin text-ember-500" />
  ) : outputOk === false ? (
    <span className="size-1.5 rounded-full bg-red-500 inline-block" />
  ) : output ? (
    <span className="size-1.5 rounded-full bg-emerald-500/70 inline-block" />
  ) : (
    <span className="size-1.5 rounded-full bg-ink-900/30 dark:bg-ink-50/30 inline-block" />
  );
  return (
    <div
      className={cn(
        "group font-mono text-[11.5px] leading-snug animate-slide-in text-ink-600 dark:text-ink-400",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <span className="grid place-items-center size-4 mt-px shrink-0">
          {statusGlyph}
        </span>
        <span className="grid place-items-center size-4 mt-px shrink-0 text-ink-500 dark:text-ink-400">
          <Icon className="h-3 w-3" />
        </span>
        <span className="font-semibold shrink-0 text-ink-800 dark:text-ink-100">
          {parsed.name}
        </span>
        {parsed.summary && (
          <span className="truncate min-w-0 flex-1 text-ink-500 dark:text-ink-400">
            {parsed.summary}
          </span>
        )}
        {(parsed.linesAdded != null || parsed.linesRemoved != null) && (
          <span className="shrink-0 inline-flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
            {parsed.linesAdded != null && parsed.linesAdded > 0 && (
              <span className="text-emerald-700 dark:text-emerald-400">
                +{parsed.linesAdded}
              </span>
            )}
            {parsed.linesRemoved != null && parsed.linesRemoved > 0 && (
              <span className="text-red-700 dark:text-red-400">
                −{parsed.linesRemoved}
              </span>
            )}
          </span>
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
      {showInlineDiff && (
        <div className="mt-1">
          <EditDiffPreview taskId={taskId} payload={parsed.editPreview!} />
        </div>
      )}
      {!showInlineDiff && showInlineCode && (
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
  // Errors are usually load-bearing — show them in full by default
  // so the operator doesn't have to expand to read "File has not
  // been read yet" or a tsc trace. Successful output stays clipped
  // at 3 lines because it's mostly noise (build chatter, ls output).
  const previewLineCount = ok ? 3 : Math.max(allLines.length, 3);
  const overflow = allLines.length - previewLineCount;
  const visible =
    expanded || !ok ? allLines : allLines.slice(0, previewLineCount);
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
            "whitespace-pre overflow-x-auto m-0 rounded",
            tone === "fail" && "text-red-700 dark:text-red-300",
            // Thin scrollbar so it doesn't eat vertical space when the
            // line overflows horizontally.
            "[&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:w-1.5",
            "[&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-ink-900/15 dark:[&::-webkit-scrollbar-thumb]:bg-ink-50/15",
            "[&::-webkit-scrollbar-track]:bg-transparent",
          )}
          style={{
            ...style,
            // Inline-style override is the only way to win against
            // the prism theme's own `backgroundColor` (also inline).
            backgroundColor: isDark
              ? "rgba(255,255,255,0.035)"
              : "rgba(0,0,0,0.035)",
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
 * `<WorkCard>` — bundles all tool calls from one agent turn into a
 * single rounded card with a tiny header (`tool calls (N)`) and a
 * "show N more" toggle for overflow. Inside, each call renders as
 * a single-line `<ToolRow>` that expands its output preview on
 * click. The shape is borrowed from t3code's WorkGroupSection but
 * tuned for our prefix language + theme tokens.
 */
export function WorkCard({
  pairs,
  className,
  defaultLimit = 8,
  liveTrailing,
  taskId,
}: {
  pairs: ReturnType<typeof pairToolEvents>;
  className?: string;
  /** Rows shown collapsed before "show more" appears. */
  defaultLimit?: number;
  /** When true, the last row shows a spinner instead of a result dot
   *  (matches the live-streaming case where the latest call hasn't
   *  resolved yet). */
  liveTrailing?: boolean;
  /** Forwarded to each `<ToolRow>` so Edit/Write rows can lazy-fetch
   *  the file for context-line synthesis. */
  taskId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (pairs.length === 0) return null;
  const overflow = pairs.length - defaultLimit;
  const visible = expanded || overflow <= 0 ? pairs : pairs.slice(-defaultLimit);
  const hidden = pairs.length - visible.length;
  return (
    <div
      className={cn(
        "rounded-lg border px-2 py-1.5 border-ink-900/[0.08] bg-ink-900/[0.015] dark:border-ink-50/[0.08] dark:bg-ink-50/[0.02]",
        className,
      )}
    >
      <div className="flex items-center justify-between mb-1 px-0.5">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] inline-flex items-center gap-1.5 text-ink-400 dark:text-ink-500">
          tool calls ({pairs.length})
        </span>
        {overflow > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-400 hover:text-ink-700 dark:text-ink-500 dark:hover:text-ink-200 transition-colors"
          >
            {expanded ? "show less" : `show ${hidden} more`}
          </button>
        )}
      </div>
      <ul className="space-y-0.5">
        {visible.map((p, i) => {
          const isLast = i === visible.length - 1;
          // Sub-agent tool calls carry `_agentdParent` in their input
          // (injected by the daemon when the upstream runner reported
          // a parent_tool_use_id). Indent + draw a left spine so the
          // operator can see "this Bash was run BY the Task spawn
          // above" instead of reading them as siblings.
          const input =
            p.input && typeof p.input === "object"
              ? (p.input as Record<string, unknown>)
              : null;
          const parentId =
            input && typeof input._agentdParent === "string"
              ? input._agentdParent
              : null;
          return (
            <li
              key={i}
              className={cn(
                parentId &&
                  "pl-3 ml-3 border-l-2 border-ink-900/15 dark:border-ink-50/15 bg-ink-900/[0.02] dark:bg-ink-50/[0.02] rounded-r",
              )}
            >
              <ToolRow
                content={`[call ${p.name}] ${JSON.stringify(p.input ?? {})}`}
                output={p.output}
                outputOk={p.ok}
                running={p.running || (liveTrailing && isLast && !p.output)}
                taskId={taskId}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Single-line tool row used inside `<WorkCard>`. Click → expand to
 * see the output preview underneath. Always renders the diff stat
 * pill + status dot inline so the row is scannable at a glance
 * without expanding.
 */
export function ToolRow({
  content,
  output,
  outputOk,
  running,
  taskId,
}: {
  content: string;
  output?: string | null;
  outputOk?: boolean;
  running?: boolean;
  taskId?: string;
}) {
  const parsed = parseToolCall(content);
  const Icon = ICONS[parsed.kind] ?? Wrench;
  const [open, setOpen] = useState(false);
  const hasOutput = !!output && output.length > 0;
  const hasInlineDetail =
    parsed.detail != null && parsed.detailLanguage != null;
  const hasInlineDiff = parsed.editPreview != null;
  const expandable = hasOutput || hasInlineDetail || hasInlineDiff;
  return (
    <div
      className={cn(
        "group rounded transition-colors animate-slide-in px-1 py-0.5",
        "hover:bg-ink-900/[0.025] dark:hover:bg-ink-50/[0.03]",
      )}
    >
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 text-left",
          expandable ? "cursor-pointer" : "cursor-default",
        )}
      >
        <span className="grid place-items-center size-4 shrink-0 relative">
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin text-ember-500" />
          ) : outputOk === false ? (
            <span className="size-1.5 rounded-full bg-red-500 inline-block" />
          ) : hasOutput ? (
            <span className="size-1.5 rounded-full bg-emerald-500/70 inline-block" />
          ) : (
            <span className="size-1.5 rounded-full bg-ink-900/30 dark:bg-ink-50/30 inline-block" />
          )}
        </span>
        <span className="grid place-items-center size-4 shrink-0 text-ink-500 dark:text-ink-400">
          <Icon className="h-3 w-3" />
        </span>
        <span className="font-mono text-[11.5px] font-semibold shrink-0 text-ink-800 dark:text-ink-100">
          {parsed.name}
        </span>
        {parsed.summary && (
          <span className="font-mono text-[11.5px] truncate min-w-0 flex-1 text-ink-500 dark:text-ink-400">
            {parsed.summary}
          </span>
        )}
        {(parsed.linesAdded != null || parsed.linesRemoved != null) && (
          <span className="shrink-0 inline-flex items-center gap-1.5 font-mono text-[10.5px] tabular-nums">
            {parsed.linesAdded != null && parsed.linesAdded > 0 && (
              <span className="text-emerald-700 dark:text-emerald-400">
                +{parsed.linesAdded}
              </span>
            )}
            {parsed.linesRemoved != null && parsed.linesRemoved > 0 && (
              <span className="text-red-700 dark:text-red-400">
                −{parsed.linesRemoved}
              </span>
            )}
          </span>
        )}
        {expandable && (
          <span className="shrink-0 text-ink-300 dark:text-ink-600">
            {open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </span>
        )}
      </button>
      {open && hasInlineDiff && (
        <div className="mt-1 ml-6">
          <EditDiffPreview taskId={taskId} payload={parsed.editPreview!} />
        </div>
      )}
      {open && !hasInlineDiff && hasInlineDetail && (
        <div className="mt-1 ml-6">
          <CodeBlock
            code={parsed.detail!}
            language={parsed.detailLanguage}
            filename={parsed.detailFilename}
            showLineNumbers={parsed.detailLanguage !== "bash"}
            diffMarks={parsed.detailDiffMarks}
          />
        </div>
      )}
      {open && hasOutput && (
        <div className="mt-1 ml-6">
          <ToolOutput
            text={output!}
            ok={outputOk !== false}
            expanded={true}
            onToggle={() => {}}
            language={inferOutputLanguage(parsed)}
          />
        </div>
      )}
    </div>
  );
}


/**
 * Pair each `tool_use` event with the immediately-following
 * `tool_result` (if any). Mirrors how the helper protocol always
 * emits them in lockstep — each call followed by its response.
 *
 * Returns objects shaped for direct `<ToolLine>` use:
 *   `{ name, input, output, ok, running }`
 *
 * `running` is always false here — pairing has no view of task
 * status, so a trailing unmatched tool_use could just as easily
 * mean "the agent stopped" as "still working." The caller passes
 * `liveTrailing` to `<WorkCard>` when it knows the agent is still
 * streaming, and that flag drives the spinner on the last row.
 */
export function pairToolEvents(
  events: ReadonlyArray<{
    kind: string;
    name?: string;
    input?: unknown;
    ok?: boolean;
    preview?: string;
    toolUseId?: string;
  }>,
): Array<{
  name: string;
  input: unknown;
  output: string | null;
  ok: boolean;
  running: boolean;
}> {
  // Build an id → result lookup so we can pair by id when claude
  // batches several tool_uses then several tool_results in one turn
  // (positional pairing alone breaks because the indexes don't line
  // up — Use1, Use2, Result2, Result1 is a real shape claude emits).
  const resultById = new Map<string, (typeof events)[number]>();
  for (const ev of events) {
    if (ev.kind === "tool_result" && typeof ev.toolUseId === "string") {
      resultById.set(ev.toolUseId, ev);
    }
  }
  const consumedIds = new Set<string>();
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
    let matched: (typeof events)[number] | null = null;
    if (ev.toolUseId && resultById.has(ev.toolUseId)) {
      matched = resultById.get(ev.toolUseId)!;
      consumedIds.add(ev.toolUseId);
    } else {
      // Fall back to the next tool_result not yet claimed by an id pair.
      for (let j = i + 1; j < events.length; j++) {
        const cand = events[j]!;
        if (cand.kind !== "tool_result") continue;
        if (cand.toolUseId && consumedIds.has(cand.toolUseId)) continue;
        matched = cand;
        if (cand.toolUseId) consumedIds.add(cand.toolUseId);
        break;
      }
    }
    out.push({
      name: ev.name,
      input: ev.input,
      output: matched?.preview ?? null,
      ok: matched?.ok !== false,
      running: false,
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
  /**
   * Lines this call added/removed (Edit/MultiEdit/Write). Surface
   * separately so the UI can render colored `+5 -2` pills next to
   * the file name — same shape claude-code shows in its terminal.
   */
  linesAdded?: number;
  linesRemoved?: number;
  /**
   * Set for Edit / MultiEdit / Write / NotebookEdit. Render uses this
   * to mount `<EditDiffPreview>` (lazy file fetch + 3-line context
   * windows) instead of a flat `<CodeBlock>`. When present, callers
   * MUST ignore `detail` / `detailDiffMarks` for this tool — the diff
   * preview component owns the body render.
   */
  editPreview?: EditPreviewPayload;
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
  // Swarm nesting metadata is injected by the daemon as
  // `_agentdParent` / `_agentdToolId` on the args object. Strip them
  // before per-tool parsing so the existing switch cases see only
  // real tool arguments.
  if ("_agentdParent" in args) delete args._agentdParent;
  if ("_agentdToolId" in args) delete args._agentdToolId;

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
      return {
        name,
        kind,
        summary: `${shortPath(path)}${offset}${limit}`,
        detail: null,
        // Carry the path so `inferOutputLanguage` can highlight the
        // file content preview (file body that the daemon attaches as
        // `tool_result.preview`) in the file's native language.
        detailFilename: path !== "?" ? shortPath(path) : undefined,
        detailLanguage: path !== "?" ? langFromPath(path) : undefined,
      };
    }
    case "Write": {
      const path = get("file_path", "path") ?? "?";
      const content = get("content");
      const lines = content ? content.split("\n").length : 0;
      return {
        name,
        kind,
        summary: shortPath(path),
        detail: null,
        editPreview:
          path !== "?" && content != null
            ? { kind: "write", path, content }
            : undefined,
        // Write creates the whole file → all lines count as added.
        linesAdded: lines || undefined,
      };
    }
    case "Edit":
    case "MultiEdit": {
      const path = get("file_path", "path") ?? "?";
      const oldStr = get("old_string") ?? "";
      const newStr = get("new_string") ?? "";
      const replaceAll = args.replace_all === true ? " (all)" : "";
      const oldLines = oldStr.length === 0 ? [] : oldStr.split("\n");
      const newLines = newStr.length === 0 ? [] : newStr.split("\n");
      return {
        name,
        kind,
        summary: `${shortPath(path)}${replaceAll}`,
        detail: null,
        editPreview:
          path !== "?" && (oldStr.length > 0 || newStr.length > 0)
            ? {
                kind: "edit",
                path,
                oldString: oldStr,
                newString: newStr,
              }
            : undefined,
        linesAdded: newLines.length || undefined,
        linesRemoved: oldLines.length || undefined,
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
    case "NotebookEdit": {
      const path = get("notebook_path", "path") ?? "?";
      const newSrc = get("new_source") ?? "";
      const oldSrc = get("old_source") ?? "";
      const oldLines = oldSrc.length === 0 ? [] : oldSrc.split("\n");
      const newLines = newSrc.length === 0 ? [] : newSrc.split("\n");
      return {
        name,
        kind: "edit",
        summary: shortPath(path),
        detail: null,
        editPreview:
          path !== "?" && (oldSrc.length > 0 || newSrc.length > 0)
            ? {
                kind: "edit",
                path,
                oldString: oldSrc,
                newString: newSrc,
              }
            : undefined,
        linesAdded: newLines.length || undefined,
        linesRemoved: oldLines.length || undefined,
      };
    }
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
