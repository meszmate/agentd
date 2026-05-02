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

  // Surface palette tokens — one set for dark, one for light — so the
  // block reads cleanly in either theme.
  const surface = isDark
    ? "bg-[#1e1e1e] border-ink-50/10"
    : "bg-[#f8f8fa] border-ink-900/10";
  const headerBg = isDark
    ? "bg-black/30 border-ink-50/10"
    : "bg-ink-900/[0.04] border-ink-900/[0.08]";
  const headerLabel = isDark ? "text-ink-50/60" : "text-ink-700";
  const copyButton = isDark
    ? "text-ink-50/55 hover:bg-ink-50/10 hover:text-ink-50"
    : "text-ink-500 hover:bg-ink-900/[0.06] hover:text-ink-900";
  const lineNumber = isDark ? "text-ink-50/30" : "text-ink-400";

  return (
    <div
      className={cn(
        "group relative my-2 overflow-hidden rounded-md border",
        surface,
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between px-3 py-1 border-b",
          headerBg,
        )}
      >
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-[0.12em] truncate font-semibold",
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
            "grid place-items-center size-5 rounded transition-colors opacity-0 group-hover:opacity-100",
            copyButton,
          )}
        >
          {copied ? (
            <Check className="h-3 w-3 text-emerald-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      </div>
      <Highlight
        code={code.replace(/\n+$/, "")}
        language={prismLang}
        theme={isDark ? themes.vsDark : themes.vsLight}
      >
        {({ className: cls, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={cn(
              cls,
              "overflow-auto py-2 font-mono text-[12px] leading-[1.55] m-0",
            )}
            style={{
              ...style,
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
              // Diffs skip the regular line-number column — the +/-
              // gutter is enough visual gutter (claude-code style).
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
                        "shrink-0 pl-2 pr-1.5 text-right select-none text-[10.5px] tabular-nums w-7",
                        lineNumber,
                      )}
                    >
                      {i + 1}
                    </span>
                  )}
                  {isDiffMode && (
                    <span
                      className={cn(
                        "shrink-0 pl-2 pr-1.5 text-center select-none text-[12px] font-bold w-6",
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
                      "whitespace-pre flex-1 pr-3",
                      !showNum && !isDiffMode && "pl-3",
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
function normalizeLanguage(raw: string): Language {
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
