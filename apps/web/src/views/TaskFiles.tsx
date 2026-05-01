import { useEffect, useMemo, useState } from "react";
import { File, FolderClosed, FolderOpen, Search } from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useFile, useFiles } from "@/queries";
import { cn } from "@/lib/utils";

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === name);
      if (!child) {
        child = { name, path, isDir: !isLast, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    );
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
  const [path, setPath] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const fileQ = useFile(taskId, path);

  useEffect(() => {
    if (fileQ.error) onError((fileQ.error as Error).message);
  }, [fileQ.error, onError]);

  const filteredPaths = useMemo(() => {
    const all = filesQ.data?.files ?? [];
    if (!filter.trim()) return all;
    const q = filter.toLowerCase();
    return all.filter((p) => p.toLowerCase().includes(q));
  }, [filesQ.data, filter]);

  const tree = useMemo(() => buildTree(filteredPaths), [filteredPaths]);

  return (
    <PanelGroup direction="horizontal" className="h-full">
      <Panel defaultSize={36} minSize={20}>
        <div className="flex h-full min-h-0 flex-col border-r border-ink-900/10 dark:border-ink-50/10">
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
                <pre className="p-3 text-xs font-mono leading-relaxed">
                  {fileQ.isLoading ? (
                    <span className="text-ink-400 dark:text-ink-500">Loading…</span>
                  ) : (
                    fileQ.data?.content ?? ""
                  )}
                </pre>
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
    </button>
  );
}
