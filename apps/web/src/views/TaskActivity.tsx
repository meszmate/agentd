import { useEffect, useMemo, useRef } from "react";
import type { Message } from "@agentd/contracts";
import { Activity } from "lucide-react";
import { ToolRow } from "@/components/tool-line";
import { LiveToolCard } from "@/components/live-tool-card";

/**
 * Live tool feed. Mirrors `claude-code`'s terminal output: each tool
 * invocation lands as its own bullet row, in chronological order, the
 * moment the model emits it. Multiple Edits to the same file appear
 * as separate entries (we deliberately do NOT collapse — that's the
 * Diff tab's job). The bottom of the list shows whatever the agent
 * is currently typing as a streaming preview, character by character.
 *
 * Auto-scrolls to the tail unless the operator has manually scrolled
 * up (claude-code "follow mode" behavior).
 */
export function TaskActivity({
  messages,
  liveTools,
}: {
  messages: Message[];
  /** Map of toolUseId → in-flight tool args being streamed. */
  liveTools: Record<string, { name: string; partial: string }>;
}) {
  const entries = useMemo(
    () => buildActivityEntries(messages, liveTools),
    [messages, liveTools],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  // Track whether the operator has scrolled away from the bottom. If
  // they have, stop auto-following so they can read history without
  // the feed yanking them back down on every new tool call.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      followRef.current = distFromBottom < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!followRef.current) return;
    tailRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, entries[entries.length - 1]?.key]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <Activity className="h-5 w-5 mx-auto mb-2 text-ink-400 dark:text-ink-500" />
          <p className="font-mono text-[11px] text-ink-500 dark:text-ink-400">
            Waiting for the agent.
          </p>
          <p className="font-mono text-[10px] text-ink-400 dark:text-ink-500 mt-1">
            Every Read / Edit / Write / Bash shows up here as it happens.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto px-3 py-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-ink-900/15 dark:[&::-webkit-scrollbar-thumb]:bg-ink-50/15 [&::-webkit-scrollbar-track]:bg-transparent"
    >
      <div className="space-y-1">
        {entries.map((e) => {
          if (e.kind === "live") {
            return (
              <LiveToolCard
                key={e.key}
                toolName={e.name}
                partial={e.partial}
              />
            );
          }
          return (
            <ToolRow
              key={e.key}
              content={`[call ${e.name}] ${JSON.stringify(e.input ?? {})}`}
              output={e.output}
              outputOk={e.ok}
              running={e.running}
            />
          );
        })}
        <div ref={tailRef} />
      </div>
    </div>
  );
}

type ActivityEntry =
  | {
      kind: "done";
      key: string;
      ts: number;
      name: string;
      input: unknown;
      output: string | null;
      ok: boolean;
      running: boolean;
    }
  | {
      kind: "live";
      key: string;
      name: string;
      partial: string;
    };

/**
 * Walk the persisted message stream + the live in-flight map and
 * produce a flat chronological list of tool entries:
 *   - Each `[call X]` message becomes one row.
 *   - Pair it with its `[result X]` by tool-use-id (or fall back to
 *     the next un-paired result, mirroring `pairToolEvents`).
 *   - Calls with no result yet render as "running" (spinner).
 *   - Streaming `liveTools` (still being typed by the model) tack on
 *     at the bottom as in-flight previews.
 */
function buildActivityEntries(
  messages: Message[],
  liveTools: Record<string, { name: string; partial: string }>,
): ActivityEntry[] {
  type Call = {
    msgId: string;
    ts: number;
    name: string;
    input: unknown;
    toolUseId?: string;
  };
  type Result = {
    ok: boolean;
    output: string;
    toolUseId?: string;
    consumed: boolean;
  };

  const calls: Call[] = [];
  const results: Result[] = [];

  for (const m of messages) {
    if (m.role !== "tool") continue;
    const resultMatch = m.content.match(
      /^\[result ([^\s\]]+) (ok|err)((?:\s+(?:[pu]):[A-Za-z0-9_-]+)*)\]\s*([\s\S]*)$/,
    );
    if (resultMatch) {
      let toolUseId: string | undefined;
      const meta = resultMatch[3] ?? "";
      for (const seg of meta.trim().split(/\s+/).filter(Boolean)) {
        const colon = seg.indexOf(":");
        if (colon < 0) continue;
        if (seg.slice(0, colon) === "u") toolUseId = seg.slice(colon + 1);
      }
      const r: Result = {
        ok: resultMatch[2] === "ok",
        output: resultMatch[4] ?? "",
        consumed: false,
      };
      if (toolUseId) r.toolUseId = toolUseId;
      results.push(r);
      continue;
    }
    const callMatch = m.content.match(/^\[call ([^\]]+)\]\s*([\s\S]*)$/);
    if (!callMatch) continue;
    let input: unknown = {};
    try {
      input = JSON.parse(callMatch[2]!);
    } catch {}
    const toolUseId =
      input &&
      typeof input === "object" &&
      typeof (input as Record<string, unknown>)._agentdToolId === "string"
        ? ((input as Record<string, unknown>)._agentdToolId as string)
        : undefined;
    const c: Call = {
      msgId: m.id,
      ts: m.ts,
      name: callMatch[1]!.trim(),
      input,
    };
    if (toolUseId) c.toolUseId = toolUseId;
    calls.push(c);
  }

  const out: ActivityEntry[] = [];
  for (const c of calls) {
    let matched: Result | null = null;
    if (c.toolUseId) {
      const r = results.find(
        (x) => !x.consumed && x.toolUseId === c.toolUseId,
      );
      if (r) {
        r.consumed = true;
        matched = r;
      }
    }
    if (!matched) {
      const r = results.find((x) => !x.consumed && !x.toolUseId);
      if (r) {
        r.consumed = true;
        matched = r;
      }
    }
    out.push({
      kind: "done",
      key: c.msgId,
      ts: c.ts,
      name: c.name,
      input: c.input,
      output: matched?.output ?? null,
      ok: matched?.ok ?? true,
      running: matched == null,
    });
  }

  for (const [id, t] of Object.entries(liveTools)) {
    out.push({ kind: "live", key: `live:${id}`, name: t.name, partial: t.partial });
  }

  return out;
}
