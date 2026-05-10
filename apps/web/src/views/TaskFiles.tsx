import { useEffect, useMemo, useState } from "react";
import { File, FolderClosed, FolderOpen, Search } from "lucide-react";
import { Highlight, themes } from "prism-react-renderer";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { langFromPath } from "@/components/code-block";
import { useTheme } from "@/components/theme-provider";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFile, useFiles, useGitStatus } from "@/queries";
import { cn } from "@/lib/utils";

type GitStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored";

interface FileStatus {
  status: GitStatusKind;
  additions: number;
  deletions: number;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  /** Aggregated for dirs (sum of descendant deltas); per-file for leaves. */
  add: number;
  del: number;
  /** Worst status seen below this node (for dirs). */
  worstStatus?: GitStatusKind;
}

const STATUS_LETTER: Record<GitStatusKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  ignored: "·",
};

const STATUS_TONE: Record<GitStatusKind, string> = {
  added: "text-emerald-700 dark:text-emerald-300",
  modified: "text-amber-700 dark:text-amber-300",
  deleted: "text-red-700 dark:text-red-300",
  renamed: "text-sky-700 dark:text-sky-300",
  untracked: "text-emerald-700 dark:text-emerald-300",
  ignored: "text-ink-400 dark:text-ink-500",
};

/** Severity ranking — lets us pick a single badge color for parent dirs. */
const STATUS_RANK: Record<GitStatusKind, number> = {
  ignored: 0,
  renamed: 1,
  untracked: 2,
  modified: 3,
  added: 4,
  deleted: 5,
};

function buildTree(
  paths: string[],
  statuses: Map<string, FileStatus>,
): TreeNode {
  const root: TreeNode = {
    name: "",
    path: "",
    isDir: true,
    children: [],
    add: 0,
    del: 0,
  };
  // Make sure every changed file gets a node in the tree even if it isn't
  // in the plain `git ls-files` listing (untracked / deleted).
  const allPaths = new Set([...paths, ...statuses.keys()]);
  for (const p of allPaths) {
    const parts = p.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === name);
      if (!child) {
        child = {
          name,
          path,
          isDir: !isLast,
          children: [],
          add: 0,
          del: 0,
        };
        node.children.push(child);
      }
      node = child;
    }
  }
  // Decorate leaves with status, then bubble counts up.
  const decorate = (n: TreeNode): void => {
    if (!n.isDir) {
      const s = statuses.get(n.path);
      if (s) {
        n.add = s.additions;
        n.del = s.deletions;
        n.worstStatus = s.status;
      }
      return;
    }
    let bestRank = -1;
    for (const c of n.children) {
      decorate(c);
      n.add += c.add;
      n.del += c.del;
      if (c.worstStatus) {
        const r = STATUS_RANK[c.worstStatus];
        if (r > bestRank) {
          bestRank = r;
          n.worstStatus = c.worstStatus;
        }
      }
    }
  };
  decorate(root);
  // Changed files first, then dirs with changes, then everything else
  // alphabetically. Inside each bucket, dirs before files.
  const sortRec = (n: TreeNode): void => {
    n.children.sort((a, b) => {
      const aChanged = (a.worstStatus ?? "ignored") !== "ignored";
      const bChanged = (b.worstStatus ?? "ignored") !== "ignored";
      if (aChanged !== bChanged) return aChanged ? -1 : 1;
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

export function TaskFiles({
  taskId,
  onError,
}: {
  taskId: string;
  onError: (m: string) => void;
}) {
  const filesQ = useFiles(taskId);
  const statusQ = useGitStatus(taskId);
  const [path, setPath] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [changesOnly, setChangesOnly] = useState(false);
  const fileQ = useFile(taskId, path);

  useEffect(() => {
    if (fileQ.error) onError((fileQ.error as Error).message);
  }, [fileQ.error, onError]);

  const statusMap = useMemo(() => {
    const m = new Map<string, FileStatus>();
    for (const e of statusQ.data?.entries ?? []) {
      m.set(e.path, {
        status: e.status,
        additions: e.additions,
        deletions: e.deletions,
      });
    }
    return m;
  }, [statusQ.data]);

  const filteredPaths = useMemo(() => {
    let all = filesQ.data?.files ?? [];
    if (changesOnly) {
      all = all.filter((p) => statusMap.has(p));
    }
    if (!filter.trim()) return all;
    const q = filter.toLowerCase();
    return all.filter((p) => p.toLowerCase().includes(q));
  }, [filesQ.data, filter, statusMap, changesOnly]);

  const tree = useMemo(
    () => buildTree(filteredPaths, statusMap),
    [filteredPaths, statusMap],
  );

  const totalAdds = statusQ.data?.entries.reduce((s, e) => s + e.additions, 0) ?? 0;
  const totalDels = statusQ.data?.entries.reduce((s, e) => s + e.deletions, 0) ?? 0;
  const changedCount = statusQ.data?.entries.length ?? 0;
  const worktree =
    filesQ.data?.worktreePath ?? statusQ.data?.worktreePath ?? "";

  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={36} minSize={20}>
        <div className="flex h-full min-h-0 flex-col border-r border-ink-900/10 dark:border-ink-50/10">
          {/* Worktree location + changes summary */}
          {worktree && (
            <div className="shrink-0 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] px-2 py-1.5 bg-paper-50/60 dark:bg-ink-900/30">
              <div
                className="font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate"
                title={worktree}
              >
                {worktree}
              </div>
              <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] tabular-nums">
                {changedCount > 0 ? (
                  <>
                    <span className="text-ink-700 dark:text-ink-200">
                      {changedCount} changed
                    </span>
                    <span className="text-emerald-700 dark:text-emerald-300">
                      +{totalAdds}
                    </span>
                    <span className="text-red-700 dark:text-red-300">
                      −{totalDels}
                    </span>
                  </>
                ) : (
                  <span className="text-ink-400 dark:text-ink-500">
                    clean worktree
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setChangesOnly((v) => !v)}
                  className={cn(
                    "ml-auto rounded border px-1 text-[10px] uppercase tracking-[0.06em] transition-colors",
                    changesOnly
                      ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                      : "border-ink-900/10 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:text-ink-400 dark:hover:text-ink-50",
                  )}
                  title="Hide unchanged files"
                >
                  {changesOnly ? "all" : "changes"}
                </button>
              </div>
            </div>
          )}

          <div className="relative shrink-0 border-b border-ink-900/10 dark:border-ink-50/10 p-1.5">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-400 dark:text-ink-500" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter files…"
              className="h-7 pl-7 text-xs bg-transparent border-transparent shadow-none focus-visible:ring-1"
            />
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-1">
              {!filesQ.data ? (
                <div className="px-2 py-3 text-center text-xs text-ink-500 dark:text-ink-400">
                  Loading…
                </div>
              ) : filteredPaths.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-ink-500 dark:text-ink-400">
                  {filter ? "No matches" : "No files"}
                </div>
              ) : (
                tree.children.map((c) => (
                  <TreeRow
                    key={c.path}
                    node={c}
                    depth={0}
                    selected={path}
                    onSelect={setPath}
                    expandAll={!!filter}
                  />
                ))
              )}
            </div>
          </ScrollArea>
          <div className="shrink-0 border-t border-ink-900/10 dark:border-ink-50/10 px-2 py-1 font-mono text-2xs text-ink-400 dark:text-ink-500">
            {filteredPaths.length} files
          </div>
        </div>
      </Panel>
      <PanelResizeHandle className="w-px bg-ink-900/10 dark:bg-ink-50/10 hover:bg-ember-500/40 transition-colors" />
      <Panel minSize={20}>
        <div className="flex h-full min-h-0 flex-col">
          {path ? (
            <>
              <div className="flex items-center justify-between border-b border-ink-900/10 dark:border-ink-50/10 px-3 py-1.5 shrink-0">
                <span className="font-mono text-xs truncate">{path}</span>
                {fileQ.data && (
                  <span className="font-mono text-2xs text-ink-400 dark:text-ink-500 shrink-0">
                    {(fileQ.data.size / 1024).toFixed(1)} KB
                  </span>
                )}
              </div>
              <ScrollArea className="flex-1 min-h-0">
                {fileQ.isLoading ? (
                  <pre className="p-3 text-xs font-mono leading-relaxed text-ink-400 dark:text-ink-500">
                    Loading…
                  </pre>
                ) : (
                  <FileContent path={path} content={fileQ.data?.content ?? ""} />
                )}
              </ScrollArea>
            </>
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-xs text-ink-500 dark:text-ink-400">
                Select a file to preview.
              </div>
            </div>
          )}
        </div>
      </Panel>
    </PanelGroup>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
  expandAll,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  expandAll: boolean;
}) {
  const [open, setOpen] = useState(expandAll || depth < 1);
  useEffect(() => {
    if (expandAll) setOpen(true);
  }, [expandAll]);

  if (node.isDir) {
    const dirAdd = node.add;
    const dirDel = node.del;
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-xs hover:bg-ink-900/[0.04] dark:hover:bg-ink-50/[0.04]"
          style={{ paddingLeft: 6 + depth * 12 }}
        >
          {open ? (
            <FolderOpen className="h-3 w-3 text-ink-400 dark:text-ink-500" />
          ) : (
            <FolderClosed className="h-3 w-3 text-ink-400 dark:text-ink-500" />
          )}
          <span className="truncate font-medium">{node.name}</span>
          {(dirAdd > 0 || dirDel > 0) && (
            <span className="ml-1 inline-flex items-center gap-1 font-mono text-[10px] tabular-nums">
              {dirAdd > 0 && (
                <span className="text-emerald-700 dark:text-emerald-300">
                  +{dirAdd}
                </span>
              )}
              {dirDel > 0 && (
                <span className="text-red-700 dark:text-red-300">
                  −{dirDel}
                </span>
              )}
            </span>
          )}
          <span className="ml-auto text-2xs text-ink-400/70 dark:text-ink-500/70">
            {node.children.length}
          </span>
        </button>
        {open && (
          <div>
            {node.children.map((c) => (
              <TreeRow
                key={c.path}
                node={c}
                depth={depth + 1}
                selected={selected}
                onSelect={onSelect}
                expandAll={expandAll}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  const statusKind = node.worstStatus;
  return (
    <button
      type="button"
      onClick={() => onSelect(node.path)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-xs",
        selected === node.path
          ? "bg-ember-500/10 text-ember-700 dark:text-ember-300"
          : "text-ink-600 hover:bg-ink-900/[0.04] hover:text-ink-900 dark:text-ink-400 dark:hover:bg-ink-50/[0.04] dark:hover:text-ink-50",
      )}
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <File className="h-3 w-3" />
      <span className="truncate">{node.name}</span>
      <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] tabular-nums">
        {node.add > 0 && (
          <span className="text-emerald-700 dark:text-emerald-300">
            +{node.add}
          </span>
        )}
        {node.del > 0 && (
          <span className="text-red-700 dark:text-red-300">−{node.del}</span>
        )}
        {statusKind && (
          <span
            className={cn(
              "font-mono text-[10px] font-bold w-3 text-center",
              STATUS_TONE[statusKind],
            )}
            title={statusKind}
          >
            {STATUS_LETTER[statusKind]}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Renders the file body. When the path resolves to a known prism
 * grammar we tokenize and color it; otherwise we fall through to a
 * plain `<pre>` so unknown / binary-ish text stays untouched. Line
 * numbers always show — same gutter as the chat's `<CodeBlock>` so the
 * two surfaces feel consistent.
 */
function FileContent({ path, content }: { path: string; content: string }) {
  const { resolved } = useTheme();
  const isDark = resolved === "dark";
  const lang = langFromPath(path);
  const lineNumberTone = isDark ? "text-ink-50/25" : "text-ink-400/70";

  if (!lang) {
    return (
      <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre">
        {content}
      </pre>
    );
  }

  return (
    <Highlight
      code={content.replace(/\n+$/, "")}
      language={lang}
      theme={isDark ? themes.oneDark : themes.oneLight}
    >
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={cn(
            className,
            "m-0 py-2 font-mono text-xs leading-relaxed",
          )}
          style={{
            ...style,
            // Win against the prism theme's inline backgroundColor so
            // the file viewer keeps the surrounding panel surface.
            backgroundColor: "transparent",
          }}
        >
          {tokens.map((line, i) => {
            const lineProps = getLineProps({ line, key: i });
            return (
              <div
                key={i}
                {...lineProps}
                className={cn(lineProps.className, "flex items-start min-w-fit")}
              >
                <span
                  className={cn(
                    "shrink-0 pl-2 pr-2 text-right select-none text-[10px] tabular-nums w-10",
                    lineNumberTone,
                  )}
                >
                  {i + 1}
                </span>
                <span className="whitespace-pre flex-1 pr-3">
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
  );
}
