import { Fragment, memo, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileMinus,
  FileEdit,
  FileSymlink,
  FileCode,
} from "lucide-react";
import {
  Highlight,
  themes,
  type Language,
  type Token,
} from "prism-react-renderer";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import { normalizeLanguage } from "@/components/code-block";

/**
 * Per-file structured diff renderer that mirrors claude-code's terminal
 * diff: a file header, then per-hunk syntax-highlighted +/- lines with
 * a two-column line-number gutter and red/green row tints. Syntax
 * highlighting tracks the file's extension so an added line in a `.ts`
 * file is colored as TypeScript, not as raw diff text.
 */

export type DiffFile = {
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  isBinary: boolean;
  language: Language;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
};

export type DiffLine = {
  kind: "add" | "del" | "ctx";
  content: string;
  oldNum: number | null;
  newNum: number | null;
};

const HUNK_HIGHLIGHT_BUDGET = 200_000;

export function parseUnifiedDiff(text: string): DiffFile[] {
  if (!text) return [];
  const out: DiffFile[] = [];
  const lines = text.split("\n");
  let cur: DiffFile | null = null;
  let curHunk: DiffHunk | null = null;
  let oldNum = 0;
  let newNum = 0;
  for (const raw of lines) {
    const line = raw ?? "";
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
      const oldPath = m && m[1] ? m[1] : null;
      const newPath = m && m[2] ? m[2] : null;
      cur = {
        oldPath,
        newPath,
        displayPath: newPath ?? oldPath ?? "",
        status: "modified",
        isBinary: false,
        language: detectLanguage(newPath ?? oldPath ?? ""),
        hunks: [],
        additions: 0,
        deletions: 0,
      };
      out.push(cur);
      curHunk = null;
      continue;
    }
    if (!cur) continue;
    const file: DiffFile = cur;
    if (line.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      file.displayPath = file.oldPath ?? file.displayPath;
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      file.status = "renamed";
      continue;
    }
    if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      file.isBinary = true;
      continue;
    }
    if (
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("index ") ||
      line.startsWith("similarity ") ||
      line.startsWith("dissimilarity ") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
      );
      if (!m) continue;
      const hunk: DiffHunk = {
        header: line,
        oldStart: parseInt(m[1] ?? "0", 10),
        oldLines: m[2] ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3] ?? "0", 10),
        newLines: m[4] ? parseInt(m[4], 10) : 1,
        lines: [],
      };
      file.hunks.push(hunk);
      curHunk = hunk;
      oldNum = hunk.oldStart;
      newNum = hunk.newStart;
      continue;
    }
    if (!curHunk) continue;
    const hunk: DiffHunk = curHunk;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      hunk.lines.push({
        kind: "add",
        content: line.slice(1),
        oldNum: null,
        newNum,
      });
      newNum++;
      file.additions++;
    } else if (line.startsWith("-")) {
      hunk.lines.push({
        kind: "del",
        content: line.slice(1),
        oldNum,
        newNum: null,
      });
      oldNum++;
      file.deletions++;
    } else if (line.startsWith(" ") || line === "") {
      hunk.lines.push({
        kind: "ctx",
        content: line.startsWith(" ") ? line.slice(1) : "",
        oldNum,
        newNum,
      });
      oldNum++;
      newNum++;
    }
  }
  return out;
}

function detectLanguage(path: string): Language {
  const base = path.split("/").pop() ?? path;
  if (/^Dockerfile/i.test(base)) return "docker" as Language;
  if (/^Makefile$/i.test(base)) return "makefile" as Language;
  if (/^Gemfile$/.test(base)) return "ruby";
  const m = /\.([a-z0-9]+)$/i.exec(base);
  const ext = m?.[1];
  if (!ext) return "tsx";
  return normalizeLanguage(ext.toLowerCase());
}

export function StructuredDiff({ files }: { files: DiffFile[] }) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {files.map((f, i) => (
        <FileBlock key={`${f.displayPath}:${i}`} file={f} />
      ))}
    </div>
  );
}

const FileBlock = memo(function FileBlock({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true);
  const StatusIcon = statusIcon(file.status);
  return (
    <div className="rounded border border-ink-900/10 dark:border-ink-50/10 bg-paper-50/40 dark:bg-ink-900/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left",
          "hover:bg-ink-900/[0.03] dark:hover:bg-ink-50/[0.04] transition-colors",
        )}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-400 dark:text-ink-500" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-400 dark:text-ink-500" />
        )}
        <StatusIcon
          className={cn(
            "h-3 w-3 shrink-0",
            file.status === "added" && "text-emerald-500",
            file.status === "deleted" && "text-red-500",
            file.status === "renamed" && "text-blue-500",
            file.status === "modified" &&
              "text-ink-500 dark:text-ink-400",
          )}
        />
        <span className="font-mono text-[11px] text-ink-900 dark:text-ink-50 truncate flex-1">
          {file.status === "renamed" && file.oldPath && file.newPath ? (
            <>
              <span className="text-ink-500 dark:text-ink-400">
                {file.oldPath}
              </span>
              <span className="mx-1 text-ink-400 dark:text-ink-500">→</span>
              <span>{file.newPath}</span>
            </>
          ) : (
            file.displayPath
          )}
        </span>
        <span className="font-mono text-[10px] tabular-nums shrink-0 text-emerald-600 dark:text-emerald-400">
          +{file.additions}
        </span>
        <span className="font-mono text-[10px] tabular-nums shrink-0 text-red-600 dark:text-red-400">
          -{file.deletions}
        </span>
      </button>
      {open && (
        <div className="border-t border-ink-900/10 dark:border-ink-50/10">
          {file.isBinary ? (
            <div className="px-3 py-2 font-mono text-[11px] text-ink-500 dark:text-ink-400">
              Binary file
            </div>
          ) : file.hunks.length === 0 ? (
            <div className="px-3 py-2 font-mono text-[11px] text-ink-500 dark:text-ink-400">
              {file.status === "renamed"
                ? "File renamed without changes."
                : "No diff content."}
            </div>
          ) : (
            <FileHunks file={file} />
          )}
        </div>
      )}
    </div>
  );
});

function FileHunks({ file }: { file: DiffFile }) {
  const numWidth = useMemo(() => {
    let max = 1;
    for (const h of file.hunks) {
      max = Math.max(
        max,
        h.oldStart + h.oldLines,
        h.newStart + h.newLines,
      );
    }
    return Math.max(2, String(max).length);
  }, [file]);

  return (
    <div className="font-mono text-[11.5px] leading-[1.5] overflow-x-auto">
      {file.hunks.map((hunk, hi) => {
        // Lines elided between (or before) hunks. Mirrors claude-code's
        // terminal "+N lines" marker so the operator can see the file
        // jumps from line 12 to line 87 instead of guessing from the
        // hunk header math. Above the first hunk, this is the stretch
        // between line 1 and oldStart.
        const prev = hi > 0 ? file.hunks[hi - 1] : null;
        const gapStart = prev ? prev.oldStart + prev.oldLines : 1;
        const gapLines = Math.max(0, hunk.oldStart - gapStart);
        return (
          <Fragment key={hi}>
            {gapLines > 0 && <HunkGap lines={gapLines} numWidth={numWidth} />}
            <div
              className={cn(
                "flex w-full px-2 py-0.5 select-none",
                "bg-ink-900/[0.03] dark:bg-ink-50/[0.04]",
                "text-ink-500 dark:text-ink-400 text-[10.5px]",
              )}
            >
              <span className="truncate">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},
                {hunk.newLines} @@
              </span>
            </div>
            <HunkBody
              hunk={hunk}
              language={file.language}
              numWidth={numWidth}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

function HunkGap({ lines, numWidth }: { lines: number; numWidth: number }) {
  const w = `${numWidth}ch`;
  return (
    <div className="flex w-full items-center select-none text-[10px] text-ink-400 dark:text-ink-500 bg-ink-900/[0.015] dark:bg-ink-50/[0.02]">
      <span className="shrink-0 px-1 text-right" style={{ minWidth: w }}>
        ⋮
      </span>
      <span className="shrink-0 px-1 text-right" style={{ minWidth: w }}>
        ⋮
      </span>
      <span className="shrink-0 w-4 text-center"> </span>
      <span className="pl-1 pr-3 italic tracking-wide">
        +{lines} {lines === 1 ? "line" : "lines"}
      </span>
    </div>
  );
}

const HunkBody = memo(function HunkBody({
  hunk,
  language,
  numWidth,
}: {
  hunk: DiffHunk;
  language: Language;
  numWidth: number;
}) {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";

  const { newCode, oldCode, skipHighlight } = useMemo(() => {
    const newLines: string[] = [];
    const oldLines: string[] = [];
    let total = 0;
    for (const l of hunk.lines) {
      total += l.content.length + 1;
      if (l.kind !== "del") newLines.push(l.content);
      if (l.kind !== "add") oldLines.push(l.content);
    }
    return {
      newCode: newLines.join("\n"),
      oldCode: oldLines.join("\n"),
      skipHighlight: total > HUNK_HIGHLIGHT_BUDGET,
    };
  }, [hunk]);

  const theme = isDark ? themes.oneDark : themes.oneLight;

  if (skipHighlight) {
    return (
      <div className="flex flex-col">
        {hunk.lines.map((line, i) => (
          <PlainRow
            key={i}
            line={line}
            numWidth={numWidth}
            isDark={isDark}
          />
        ))}
      </div>
    );
  }

  return (
    <Highlight code={newCode || " "} language={language} theme={theme}>
      {({ tokens: newTokens, getTokenProps }) => (
        <Highlight code={oldCode || " "} language={language} theme={theme}>
          {({ tokens: oldTokens }) => {
            const rows: React.ReactNode[] = [];
            let ni = 0;
            let oi = 0;
            hunk.lines.forEach((line, idx) => {
              let toks: Token[] | undefined;
              if (line.kind === "add") {
                toks = newTokens[ni];
                ni++;
              } else if (line.kind === "del") {
                toks = oldTokens[oi];
                oi++;
              } else {
                toks = newTokens[ni];
                ni++;
                oi++;
              }
              rows.push(
                <DiffRow
                  key={idx}
                  line={line}
                  tokens={toks ?? []}
                  getTokenProps={getTokenProps}
                  numWidth={numWidth}
                  isDark={isDark}
                />,
              );
            });
            return <div className="flex flex-col">{rows}</div>;
          }}
        </Highlight>
      )}
    </Highlight>
  );
});

function DiffRow({
  line,
  tokens,
  getTokenProps,
  numWidth,
  isDark,
}: {
  line: DiffLine;
  tokens: Token[];
  getTokenProps: (input: { token: Token; key?: React.Key }) => {
    children?: string;
    style?: React.CSSProperties;
    className?: string;
  };
  numWidth: number;
  isDark: boolean;
}) {
  const tone = rowTone(line.kind);
  return (
    <div className={cn("flex w-full min-w-fit items-start", tone)}>
      <Gutter line={line} numWidth={numWidth} isDark={isDark} />
      <Marker kind={line.kind} />
      <span className="whitespace-pre flex-1 pr-3 pl-1">
        {tokens.length === 0 ? (
          <span> </span>
        ) : (
          tokens.map((t, j) => (
            <span key={j} {...getTokenProps({ token: t, key: j })} />
          ))
        )}
      </span>
    </div>
  );
}

function PlainRow({
  line,
  numWidth,
  isDark,
}: {
  line: DiffLine;
  numWidth: number;
  isDark: boolean;
}) {
  const tone = rowTone(line.kind);
  return (
    <div className={cn("flex w-full min-w-fit items-start", tone)}>
      <Gutter line={line} numWidth={numWidth} isDark={isDark} />
      <Marker kind={line.kind} />
      <span className="whitespace-pre flex-1 pr-3 pl-1 text-ink-900 dark:text-ink-50">
        {line.content || " "}
      </span>
    </div>
  );
}

function Gutter({
  line,
  numWidth,
  isDark: _isDark,
}: {
  line: DiffLine;
  numWidth: number;
  isDark: boolean;
}) {
  const cellCls = cn(
    "shrink-0 px-1 text-right select-none tabular-nums text-[10px]",
    "text-ink-400/80 dark:text-ink-500/80",
  );
  const w = `${numWidth}ch`;
  return (
    <>
      <span className={cellCls} style={{ minWidth: w }}>
        {line.oldNum ?? ""}
      </span>
      <span className={cellCls} style={{ minWidth: w }}>
        {line.newNum ?? ""}
      </span>
    </>
  );
}

function Marker({ kind }: { kind: DiffLine["kind"] }) {
  return (
    <span
      className={cn(
        "shrink-0 w-4 text-center select-none font-bold text-[11px]",
        kind === "add"
          ? "text-emerald-600 dark:text-emerald-400"
          : kind === "del"
            ? "text-red-600 dark:text-red-400"
            : "text-ink-300 dark:text-ink-600",
      )}
    >
      {kind === "add" ? "+" : kind === "del" ? "-" : " "}
    </span>
  );
}

function rowTone(kind: DiffLine["kind"]): string {
  if (kind === "add")
    return "bg-emerald-500/[0.10] dark:bg-emerald-500/[0.14]";
  if (kind === "del") return "bg-red-500/[0.10] dark:bg-red-500/[0.14]";
  return "";
}

function statusIcon(status: DiffFile["status"]) {
  switch (status) {
    case "added":
      return FilePlus;
    case "deleted":
      return FileMinus;
    case "renamed":
      return FileSymlink;
    case "modified":
      return FileEdit;
    default:
      return FileCode;
  }
}
