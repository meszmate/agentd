import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ClipboardList,
  Edit,
  FileSearch,
  FileText,
  Folder,
  Globe,
  Loader2,
  Notebook,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { useApp, useClient } from "@/AppContext";
import { useRealtime } from "@/realtime";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { cn, formatTs, shortId } from "@/lib/utils";

/**
 * Catalog of tools the underlying agent CLIs (claude, codex) can call.
 * agentd doesn't gate any of these — they're enabled/disabled by the CLI's
 * own permission system. The Tools page is informational + observability.
 *
 * Keeping this list curated rather than auto-discovered means we can ship
 * descriptions and tags. Unknown tools (e.g. MCP tools the user wires up
 * themselves) still appear under "Other" once they show up in real usage.
 */
interface ToolMeta {
  name: string;
  description: string;
  category: "files" | "shell" | "web" | "search" | "agent" | "notebook";
  icon: React.ComponentType<{ className?: string }>;
}

const CATALOG: ToolMeta[] = [
  // Files
  {
    name: "Read",
    description: "Reads a file from the local filesystem.",
    category: "files",
    icon: FileText,
  },
  {
    name: "Write",
    description: "Writes a file (overwrites existing).",
    category: "files",
    icon: FileText,
  },
  {
    name: "Edit",
    description: "Performs exact string replacements in a file.",
    category: "files",
    icon: Edit,
  },
  // Shell
  {
    name: "Bash",
    description: "Runs a shell command in the agent's worktree.",
    category: "shell",
    icon: Terminal,
  },
  // Search
  {
    name: "Grep",
    description: "Searches file contents with ripgrep.",
    category: "search",
    icon: Search,
  },
  {
    name: "Glob",
    description: "Lists files matching a pattern.",
    category: "search",
    icon: Folder,
  },
  // Web
  {
    name: "WebFetch",
    description: "Fetches a URL and returns its rendered text.",
    category: "web",
    icon: Globe,
  },
  {
    name: "WebSearch",
    description: "Runs a web search and returns top results.",
    category: "web",
    icon: Globe,
  },
  // Agent / planning
  {
    name: "Task",
    description: "Spawns a sub-agent for an isolated investigation.",
    category: "agent",
    icon: Bot,
  },
  {
    name: "TodoWrite",
    description: "Persists a structured task plan checklist.",
    category: "agent",
    icon: ClipboardList,
  },
  // Notebook
  {
    name: "NotebookEdit",
    description: "Edits a Jupyter notebook cell in place.",
    category: "notebook",
    icon: Notebook,
  },
  {
    name: "Read (notebook)",
    description: "Reads a Jupyter notebook with cell outputs.",
    category: "notebook",
    icon: Notebook,
  },
];

const CATEGORY_LABEL: Record<ToolMeta["category"], string> = {
  files: "Files",
  shell: "Shell",
  web: "Web",
  search: "Search",
  agent: "Agent",
  notebook: "Notebook",
};

const CATEGORY_ORDER: ToolMeta["category"][] = [
  "files",
  "shell",
  "search",
  "web",
  "agent",
  "notebook",
];

/**
 * Pull "preview" args off our `[call <name>] <argsJson>` log entries to
 * surface a useful one-liner in the recent feed. We deliberately don't
 * pretty-print the full args (often a long file path or shell command) —
 * just the first ~100 chars trimmed and unquoted.
 */
function previewLine(preview: string): string {
  const trimmed = preview.trim();
  if (!trimmed) return "";
  // Try to extract a known-useful arg key: file_path / path / command / pattern.
  const match = /"(file_path|path|command|pattern|url|query)"\s*:\s*"([^"]+)"/.exec(
    trimmed,
  );
  if (match) return match[2]!.slice(0, 100);
  return trimmed.slice(0, 100);
}

export function Tools() {
  const client = useClient();
  const { live } = useRealtime();
  void useApp();

  // Realtime nudges this query to refetch — every tool_call event in the
  // bus invalidates implicitly via the query refetch interval. The interval
  // is short (5s) only because the data is cheap and the page is read-only.
  const statsQ = useQuery({
    queryKey: ["tools", "stats"] as const,
    queryFn: () => client.getToolStats(50),
    refetchInterval: 5_000,
    staleTime: 4_000,
  });

  const counts = statsQ.data?.counts ?? {};
  const total = statsQ.data?.total ?? 0;
  const recent = statsQ.data?.recent ?? [];

  // Merge the curated catalog with any tool names we've actually seen in
  // the wild. Anything not in the catalog falls under "Other" so MCP tools
  // and per-project additions still show up with a count.
  const grouped = useMemo(() => {
    const seen = new Set(CATALOG.map((c) => c.name));
    const other: ToolMeta[] = [];
    for (const name of Object.keys(counts)) {
      if (seen.has(name)) continue;
      other.push({
        name,
        description: "Custom or MCP tool — not in the built-in catalog.",
        category: "agent",
        icon: Wrench,
      });
      seen.add(name);
    }
    const all = [...CATALOG, ...other];
    const byCat = new Map<ToolMeta["category"], ToolMeta[]>();
    for (const t of all) {
      const arr = byCat.get(t.category) ?? [];
      arr.push(t);
      byCat.set(t.category, arr);
    }
    return CATEGORY_ORDER.map((cat) => ({
      category: cat,
      label: CATEGORY_LABEL[cat],
      tools: byCat.get(cat) ?? [],
    }));
  }, [counts]);

  const topByCount = useMemo(
    () =>
      Object.entries(counts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8),
    [counts],
  );
  const maxCount = topByCount[0]?.[1] ?? 0;

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>capabilities</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Tools
        </span>
        <Count>{Object.keys(counts).length} active</Count>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 hidden md:inline">
          built-in catalog · live counts
        </span>
        <Spacer />
        <span
          className={cn(
            "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em]",
            live ? "text-ember-700 dark:text-ember-300" : "text-ink-500",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              live ? "bg-ember-500 animate-blink" : "bg-ink-300 dark:bg-ink-600",
            )}
          />
          {live ? "live" : "off"}
        </span>
        {statsQ.isFetching && (
          <Loader2 className="h-3 w-3 animate-spin text-ink-400" />
        )}
      </PageTopbar>

      <div
        id="tools-scroll"
        className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5"
      >
        {/* Stats strip — 4 cards across on wide screens */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total tool calls"
            value={total.toLocaleString()}
            hint="across every task ever run"
          />
          <StatCard
            label="Unique tools"
            value={String(Object.keys(counts).length)}
            hint="distinct names invoked"
          />
          <StatCard
            label="Top tool"
            value={topByCount[0]?.[0] ?? "—"}
            hint={
              topByCount[0]
                ? `${topByCount[0][1].toLocaleString()} calls`
                : "no calls yet"
            }
          />
          <StatCard
            label="Tracked since"
            value={
              statsQ.data?.earliest ? formatTs(statsQ.data.earliest) : "—"
            }
            hint="first tool_call we logged"
          />
        </div>

        {/* Most used (left) + Recent (right) — split on wide screens, stack
            on narrow. Inner sections grow to fill the available height. */}
        <div className="grid gap-5 lg:grid-cols-12">
          {topByCount.length > 0 && (
            <section className="lg:col-span-7 flex flex-col rounded-md border border-ink-900/[0.08] bg-paper-50 dark:border-ink-50/[0.08] dark:bg-ink-800/40">
              <div className="flex items-baseline justify-between border-b border-ink-900/[0.06] px-4 py-2.5 dark:border-ink-50/[0.06]">
                <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                  Most used
                </h3>
                <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                  top {topByCount.length}
                </span>
              </div>
              <ul className="flex-1 space-y-1.5 px-4 py-3">
                {topByCount.map(([name, count]) => {
                  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  return (
                    <li
                      key={name}
                      className="grid grid-cols-[160px_1fr_auto] items-center gap-3 text-[12px]"
                    >
                      <span className="font-mono text-ink-700 dark:text-ink-200 truncate">
                        {name}
                      </span>
                      <div className="h-2 w-full rounded-full bg-ink-900/[0.05] dark:bg-ink-50/[0.06] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-ember-500/70 transition-[width] duration-300"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="font-mono text-[11px] tabular-nums text-ink-500 dark:text-ink-400">
                        {count.toLocaleString()}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section
            className={cn(
              "flex flex-col rounded-md border border-ink-900/[0.08] bg-paper-50 dark:border-ink-50/[0.08] dark:bg-ink-800/40",
              topByCount.length > 0 ? "lg:col-span-5" : "lg:col-span-12",
            )}
          >
            <div className="flex items-baseline justify-between border-b border-ink-900/[0.06] px-4 py-2.5 dark:border-ink-50/[0.06]">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                Recent calls
              </h3>
              <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
                {recent.length} shown · refresh 5s
              </span>
            </div>
            {recent.length === 0 ? (
              <div className="flex flex-1 items-center gap-2 px-4 py-6 text-[12px] text-ink-500 dark:text-ink-400">
                <FileSearch className="h-3.5 w-3.5" />
                no tool calls yet — spawn a task to populate.
              </div>
            ) : (
              <ul className="flex-1 max-h-[420px] overflow-y-auto divide-y divide-ink-900/[0.05] dark:divide-ink-50/[0.05]">
                {recent.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 px-4 py-2 text-[12px]"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-sky-700 dark:text-sky-300 shrink-0 w-24 truncate">
                      {r.tool}
                    </span>
                    <span className="font-mono text-[11px] text-ink-700 dark:text-ink-200 flex-1 min-w-0 truncate">
                      {previewLine(r.preview)}
                    </span>
                    <Link
                      to={`/tasks/${r.taskId}`}
                      className="hidden xl:block font-mono text-[10px] text-ink-500 dark:text-ink-400 hover:text-ember-700 dark:hover:text-ember-300 truncate max-w-[180px]"
                      title={r.taskTitle ?? r.taskId}
                    >
                      {r.taskTitle ?? shortId(r.taskId)}
                    </Link>
                    <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0 w-14 text-right">
                      {formatTs(r.ts)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Catalog — fills the full width with a generous grid on big screens */}
        {grouped.map(({ category, label, tools }) =>
          tools.length === 0 ? null : (
            <section key={category}>
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
                {label}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {tools.map((t) => {
                  const count = counts[t.name] ?? 0;
                  const Icon = t.icon;
                  return (
                    <div
                      key={t.name}
                      className="rounded-md border border-ink-900/[0.08] bg-paper-50 p-3 dark:border-ink-50/[0.08] dark:bg-ink-800/40"
                    >
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 grid place-items-center size-7 shrink-0 rounded-md border border-ink-900/[0.08] bg-paper-100 text-ink-500 dark:border-ink-50/[0.08] dark:bg-ink-900/40 dark:text-ink-400">
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="font-mono text-[12px] font-medium text-ink-900 dark:text-ink-50 truncate">
                              {t.name}
                            </span>
                            <span
                              className={cn(
                                "ml-auto font-mono text-[10px] tabular-nums shrink-0",
                                count > 0
                                  ? "text-ember-700 dark:text-ember-300"
                                  : "text-ink-400 dark:text-ink-500",
                              )}
                            >
                              {count.toLocaleString()}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] leading-relaxed text-ink-500 dark:text-ink-400">
                            {t.description}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ),
        )}

        <p className="text-[11px] text-ink-400 dark:text-ink-500 leading-relaxed max-w-prose">
          Tools come from the underlying agent CLIs (
          <span className="font-mono">claude</span>,{" "}
          <span className="font-mono">codex</span>) and any MCP servers
          they're connected to. agentd doesn't gate them — permission
          decisions live in the per-task permission mode and the CLI's
          own settings.
        </p>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-md border border-ink-900/[0.08] bg-paper-50 p-3 dark:border-ink-50/[0.08] dark:bg-ink-800/40">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
        {label}
      </div>
      <div className="mt-1 font-display text-2xl text-ink-900 dark:text-ink-50 truncate">
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-ink-500 dark:text-ink-400">
        {hint}
      </div>
    </div>
  );
}
