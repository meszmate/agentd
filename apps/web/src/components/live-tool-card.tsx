import { memo, useMemo } from "react";
import { Edit3, FileText, Loader2, Wrench } from "lucide-react";
import { CodeBlock } from "@/components/code-block";
import { langFromPath } from "@/components/tool-line";
import { cn } from "@/lib/utils";

/**
 * Real-time view of what the agent is currently doing.
 *
 * As the model decides to call a tool, Anthropic streams the arguments
 * as `input_json_delta` chunks (not all at once). This component reads
 * those partial JSON chunks live and pulls out the file path + content
 * for Edit / Write / MultiEdit, so the operator literally watches the
 * file being typed character by character, the same way claude-code's
 * terminal preview does it. Bash shows the command as it forms; other
 * tools fall back to raw partial JSON.
 *
 * The card is purely transient. The instant the full `tool_call` event
 * arrives with complete args, this card disappears and the persisted
 * ToolRow in the timeline takes over.
 */
export const LiveToolCard = memo(function LiveToolCard({
  toolName,
  partial,
}: {
  toolName: string;
  partial: string;
}) {
  const view = useMemo(() => parsePartialToolInput(toolName, partial), [
    toolName,
    partial,
  ]);
  const Icon =
    toolName === "Edit" || toolName === "MultiEdit"
      ? Edit3
      : toolName === "Write"
        ? FileText
        : Wrench;

  return (
    <div className="rounded-lg border border-ember-500/30 bg-ember-500/[0.04] dark:bg-ember-500/[0.06] px-2.5 py-2 animate-slide-in">
      <div className="flex items-center gap-2 mb-1.5">
        <Loader2 className="h-3 w-3 animate-spin text-ember-500 shrink-0" />
        <Icon className="h-3 w-3 text-ink-500 dark:text-ink-400 shrink-0" />
        <span className="font-mono text-[11.5px] font-semibold text-ink-800 dark:text-ink-100 shrink-0">
          {toolName}
        </span>
        {view.path && (
          <span className="font-mono text-[11.5px] truncate min-w-0 flex-1 text-ink-500 dark:text-ink-400">
            {view.path}
          </span>
        )}
        <span
          className={cn(
            "font-mono text-[9.5px] uppercase tracking-[0.12em] shrink-0",
            "bg-clip-text text-transparent",
            "bg-[linear-gradient(90deg,rgba(194,65,12,0.45),rgba(194,65,12,1),rgba(194,65,12,0.45))]",
            "dark:bg-[linear-gradient(90deg,rgba(252,165,107,0.4),rgba(252,165,107,1),rgba(252,165,107,0.4))]",
            "bg-[length:200%_100%] animate-shimmer",
          )}
        >
          writing
        </span>
      </div>
      {view.body != null ? (
        <div className="relative">
          <CodeBlock
            code={view.body || " "}
            language={view.language}
            filename={view.path ?? undefined}
            showLineNumbers={view.language !== "bash"}
          />
          <span
            className={cn(
              "pointer-events-none absolute right-3 bottom-2",
              "inline-block w-1.5 h-3.5 align-text-bottom bg-ember-500/70 animate-blink",
            )}
          />
        </div>
      ) : (
        <pre className="font-mono text-[10.5px] leading-snug text-ink-500 dark:text-ink-400 whitespace-pre-wrap break-all max-h-32 overflow-hidden">
          {partial}
        </pre>
      )}
    </div>
  );
});

interface PartialView {
  path: string | null;
  body: string | null;
  language?: string;
}

function parsePartialToolInput(name: string, json: string): PartialView {
  switch (name) {
    case "Write": {
      const path = extractStringField(json, "file_path") ?? extractStringField(json, "path");
      const body = extractStringField(json, "content");
      return {
        path: path ?? null,
        body: body ?? null,
        language: path ? langFromPath(path) : undefined,
      };
    }
    case "Edit":
    case "MultiEdit": {
      const path = extractStringField(json, "file_path") ?? extractStringField(json, "path");
      // While streaming, prefer new_string (the post-state). old_string
      // shows up first in the stream but the operator cares about what
      // the file is becoming, not what it was.
      const newStr = extractStringField(json, "new_string");
      const oldStr = extractStringField(json, "old_string");
      const body = newStr ?? oldStr;
      return {
        path: path ?? null,
        body: body ?? null,
        language: path ? langFromPath(path) : undefined,
      };
    }
    case "Bash": {
      const cmd = extractStringField(json, "command");
      return {
        path: null,
        body: cmd ?? null,
        language: "bash",
      };
    }
    default:
      return { path: null, body: null };
  }
}

/**
 * Best-effort extraction of `"<key>":"<string>"` from a possibly-truncated
 * JSON blob. Honors standard JSON string escapes (\n \t \" \\ \uXXXX) and
 * returns whatever has been streamed so far if the closing quote hasn't
 * arrived yet. Returns null if the key isn't present at all (so we know
 * to fall back to the raw-JSON view) instead of empty-string, which would
 * render a blank code block.
 */
function extractStringField(json: string, key: string): string | null {
  const needle = `"${key}"`;
  let idx = -1;
  let from = 0;
  while ((idx = json.indexOf(needle, from)) !== -1) {
    // Make sure this isn't inside a string literal (a quoted value
    // happens to contain the key text). Cheap heuristic: count
    // unescaped quotes up to idx; even count = outside a string.
    if (!isInsideString(json, idx)) break;
    from = idx + needle.length;
  }
  if (idx === -1) return null;
  let p = idx + needle.length;
  // skip whitespace + colon
  while (p < json.length && /\s/.test(json[p]!)) p++;
  if (json[p] !== ":") return null;
  p++;
  while (p < json.length && /\s/.test(json[p]!)) p++;
  if (json[p] !== '"') return null;
  p++;
  let out = "";
  while (p < json.length) {
    const c = json[p]!;
    if (c === "\\") {
      const next = json[p + 1];
      if (next === undefined) break;
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "/":
          out += "/";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "u": {
          const hex = json.slice(p + 2, p + 6);
          if (hex.length < 4) return out;
          const cp = parseInt(hex, 16);
          if (Number.isNaN(cp)) return out;
          out += String.fromCharCode(cp);
          p += 6;
          continue;
        }
        default:
          out += next;
      }
      p += 2;
      continue;
    }
    if (c === '"') return out;
    out += c;
    p++;
  }
  return out;
}

function isInsideString(json: string, at: number): boolean {
  let inStr = false;
  let esc = false;
  for (let i = 0; i < at; i++) {
    const c = json[i]!;
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
  }
  return inStr;
}
