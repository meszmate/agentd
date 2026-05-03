import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

/**
 * Syntax-highlighted code block — renders fenced markdown blocks
 * and tool-call file content (Edit/Write outputs) the way claude-code
 * and codex do in the terminal: monospaced, line-numbered, language
 * label in the corner, copy-to-clipboard button on hover.
 *
 * Themes track the operator's app theme (dark/light) via prism's
 * built-in vsDark / vsLight palettes so the block blends with the
 * surrounding chat without clashing.
 */
export function CodeBlock({
  code,
  language,
  filename,
  className,
  showLineNumbers = true,
  maxHeight = "22rem",
  diffMarks,
}: {
  code: string;
  language?: string;
  /** Optional path/filename shown as a label in the header. */
  filename?: string;
  className?: string;
  showLineNumbers?: boolean;
  /** Cap visible height; content beyond scrolls. Pass `null` to disable. */
  maxHeight?: string | null;
  /**
   * Per-line diff marker — `"+"` highlights the row with a green
   * wash, `"-"` red, anything else is a context line. The grammar
   * stays the file's native language so prism still colors the
   * code; the row tint is the only visual indication of the diff.
   */
  diffMarks?: Array<"+" | "-" | " " | null>;
}) {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";
  const lang = (language ?? "").toLowerCase().trim();
  const prismLang = normalizeLanguage(lang);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — most browsers will allow this in secure contexts
    }
  };

  const label = filename ?? (lang || "text");

  // No box. The "code block" is just a small filename caption (mono,
  // low-contrast) followed by syntax-highlighted lines flush with the
  // surrounding text — terminal feel, not IDE-panel feel.
  const headerLabel = isDark ? "text-ink-50/45" : "text-ink-500";
  const copyButton = isDark
    ? "text-ink-50/55 hover:bg-ink-50/10 hover:text-ink-50"
    : "text-ink-500 hover:bg-ink-900/[0.06] hover:text-ink-900";
  const lineNumber = isDark ? "text-ink-50/25" : "text-ink-400/70";

  // Subtle background tint sits only on the code body (applied
  // inline so it wins against the prism theme's own bg). Slightly
  // darker than the surrounding paper in light mode; slightly
  // lighter than ink in dark mode. No border — just a flat surface
  // that distinguishes the code from prose without becoming a card.
  return (
    <div className={cn("group relative my-1.5", className)}>
      <div className="flex items-center justify-between mb-0.5">
        <span
          className={cn(
            "font-mono text-[10px] tabular-nums truncate",
            headerLabel,
          )}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={copy}
          title="Copy"
          className={cn(
            "grid place-items-center size-4 rounded transition-colors opacity-0 group-hover:opacity-100",
            copyButton,
          )}
        >
          {copied ? (
            <Check className="h-2.5 w-2.5 text-emerald-500" />
          ) : (
            <Copy className="h-2.5 w-2.5" />
          )}
        </button>
      </div>
      <Highlight
        code={code.replace(/\n+$/, "")}
        language={prismLang}
        theme={isDark ? themes.oneDark : themes.oneLight}
      >
        {({ className: cls, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={cn(
              cls,
              "overflow-auto font-mono text-[11.5px] leading-[1.5] m-0 px-2 py-1 rounded",
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
              ...(maxHeight ? { maxHeight } : {}),
            }}
          >
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line, key: i });
              // External diff metadata wins (Edit/MultiEdit). When
              // absent, fall back to detecting "+" / "-" prefixes for
              // raw `language=diff` blocks.
              const externalMark = diffMarks?.[i];
              const firstText = line[0]?.content ?? "";
              const isRawDiff = !diffMarks && prismLang === "diff";
              const diffMark: "+" | "-" | null =
                externalMark === "+" || externalMark === "-"
                  ? externalMark
                  : isRawDiff && firstText.startsWith("+")
                    ? "+"
                    : isRawDiff && firstText.startsWith("-")
                      ? "-"
                      : null;
              const diffTone =
                diffMark === "+"
                  ? "bg-emerald-500/[0.14]"
                  : diffMark === "-"
                    ? "bg-red-500/[0.14]"
                    : "";
              const isDiffMode = !!diffMarks || isRawDiff;
              const showNum = showLineNumbers && !isDiffMode;
              return (
                <div
                  key={i}
                  {...lineProps}
                  className={cn(
                    lineProps.className,
                    "flex items-start min-w-fit",
                    diffTone,
                  )}
                >
                  {showNum && (
                    <span
                      className={cn(
                        "shrink-0 pl-1.5 pr-1 text-right select-none text-[9.5px] tabular-nums w-6",
                        lineNumber,
                      )}
                    >
                      {i + 1}
                    </span>
                  )}
                  {isDiffMode && (
                    <span
                      className={cn(
                        "shrink-0 pl-1.5 pr-1 text-center select-none text-[10.5px] font-bold w-5",
                        diffMark === "+"
                          ? "text-emerald-400"
                          : diffMark === "-"
                            ? "text-red-400"
                            : "text-ink-50/30 dark:text-ink-50/30",
                      )}
                    >
                      {diffMark ?? " "}
                    </span>
                  )}
                  <span
                    className={cn(
                      "whitespace-pre flex-1 pr-2",
                      !showNum && !isDiffMode && "pl-2",
                    )}
                  >
                    {line.map((token, j) => (
                      <span key={j} {...getTokenProps({ token, key: j })} />
                    ))}
                  </span>
                </div>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

/**
 * Map markdown fence languages to whatever prism's bundled grammars
 * recognize. prism-react-renderer ships a small set; everything else
 * falls back to plain text (still monospaced + line-numbered).
 */
export function normalizeLanguage(raw: string): Language {
  switch (raw) {
    case "ts":
    case "tsx":
    case "typescript":
      return "tsx";
    case "js":
    case "jsx":
    case "javascript":
      return "jsx";
    case "py":
    case "python":
      return "python";
    case "rs":
    case "rust":
      return "rust";
    case "go":
    case "golang":
      return "go";
    case "rb":
    case "ruby":
      return "ruby";
    case "sh":
    case "bash":
    case "zsh":
    case "shell":
      return "bash";
    case "yml":
    case "yaml":
      return "yaml";
    case "md":
    case "markdown":
      return "markdown";
    case "json":
    case "jsonc":
      return "json";
    case "html":
    case "htm":
      return "markup";
    case "xml":
    case "svg":
      return "markup";
    case "css":
      return "css";
    case "sql":
      return "sql";
    case "diff":
    case "patch":
      return "diff";
    default:
      return (raw as Language) || "tsx";
  }
}
