import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  FolderClosed,
  FolderGit2,
  Loader2,
  Plus,
  Search as SearchIcon,
  X,
} from "lucide-react";
import type { Project } from "@agentd/contracts";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useApp, useClient } from "@/AppContext";
import { useProjects } from "@/queries";
import { qk } from "@/queries";
import { cn } from "@/lib/utils";

interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isGit: boolean;
}
interface FsListing {
  path: string;
  parent: string | null;
  isGit: boolean;
  entries: FsEntry[];
}

interface Props {
  /** Selected project id, or empty for none. */
  value: string;
  onChange: (project: { id: string; path: string; name: string }) => void;
  /** Optional className applied to the trigger row. */
  className?: string;
  autoFocus?: boolean;
}

/**
 * Project-first repo selector. There is no typeable text field — the user
 * either picks a saved project or hits "Add project" to register a new one
 * via a browse-only filesystem picker. Selecting a project hands the caller
 * its id + path + name; spawn flows use the path as the repo for the
 * worktree, and the daemon associates the new task with the project.
 */
export function ProjectPicker({
  value,
  onChange,
  className,
  autoFocus,
}: Props) {
  const projectsQ = useProjects();
  const projects = projectsQ.data?.projects ?? [];
  const selected = projects.find((p) => p.id === value) ?? null;

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            autoFocus={autoFocus}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-md border border-ink-900/15 bg-paper-50 px-2.5 text-left transition-colors hover:bg-paper-100 hover:border-ink-900/25 dark:border-ink-50/15 dark:bg-ink-800 dark:hover:bg-ink-700",
              className,
            )}
          >
            <FolderGit2 className="h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0" />
            {selected ? (
              <>
                <span className="text-[12px] font-medium text-ink-900 dark:text-ink-50 truncate">
                  {selected.name}
                </span>
                <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate">
                  {selected.path}
                </span>
              </>
            ) : (
              <span className="text-[12px] text-ink-500 dark:text-ink-400">
                {projects.length === 0 ? "Add a project…" : "Pick a project…"}
              </span>
            )}
            <ChevronDown className="ml-auto h-3.5 w-3.5 text-ink-400 dark:text-ink-500 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[420px] p-0 overflow-hidden"
          sideOffset={4}
        >
          <ProjectList
            projects={projects}
            selectedId={value}
            onSelect={(p) => {
              onChange({ id: p.id, path: p.path, name: p.name });
              setPopoverOpen(false);
            }}
            onAdd={() => {
              setPopoverOpen(false);
              setAddOpen(true);
            }}
          />
        </PopoverContent>
      </Popover>

      <AddProjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(p) => {
          onChange({ id: p.id, path: p.path, name: p.name });
          setAddOpen(false);
        }}
      />
    </>
  );
}

/* ── List of saved projects ─────────────────────────────────────── */

function ProjectList({
  projects,
  selectedId,
  onSelect,
  onAdd,
}: {
  projects: Project[];
  selectedId: string;
  onSelect: (p: Project) => void;
  onAdd: () => void;
}) {
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [projects, filter]);

  return (
    <div className="flex max-h-[480px] flex-col">
      {projects.length > 4 && (
        <div className="relative border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3 w-3 text-ink-400 dark:text-ink-500" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter projects…"
            className="h-8 border-0 rounded-none pl-8 text-[12px] focus-visible:ring-0 bg-transparent shadow-none"
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-ink-500 dark:text-ink-400">
            {projects.length === 0
              ? "No projects yet — add one to get started."
              : "No matching projects."}
          </div>
        ) : (
          <ul>
            {filtered.map((p) => {
              const active = p.id === selectedId;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(p)}
                    className={cn(
                      "group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                      active
                        ? "bg-ember-500/10"
                        : "hover:bg-paper-100 dark:hover:bg-ink-700",
                    )}
                  >
                    <span
                      className="size-2 rounded-sm shrink-0"
                      style={{ background: p.color ?? "#FF5C28" }}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[12px] font-medium text-ink-900 dark:text-ink-50 truncate">
                        {p.name}
                      </span>
                      <span className="block font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
                        {p.path}
                      </span>
                    </span>
                    {(p.activeCount ?? 0) > 0 && (
                      <span className="font-mono text-[10px] tabular-nums text-ember-700 dark:text-ember-300 shrink-0">
                        {p.activeCount} live
                      </span>
                    )}
                    {(p.taskCount ?? 0) > 0 && (
                      <span className="font-mono text-[10px] tabular-nums text-ink-400 dark:text-ink-500 shrink-0 w-8 text-right">
                        {p.taskCount}
                      </span>
                    )}
                    {active && (
                      <Check className="h-3.5 w-3.5 text-ember-700 dark:text-ember-300 shrink-0" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-2 border-t border-ink-900/[0.06] bg-paper-100/40 px-3 py-2 text-left transition-colors hover:bg-paper-100 dark:border-ink-50/[0.06] dark:bg-ink-900/30 dark:hover:bg-ink-700"
      >
        <Plus className="h-3.5 w-3.5 text-ember-500 shrink-0" />
        <span className="text-[12px] text-ink-700 dark:text-ink-200">
          Add project
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
          browse
        </span>
      </button>
    </div>
  );
}

/* ── Add-project dialog (name + browse) ─────────────────────────── */

function AddProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (p: Project) => void;
}) {
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();
  const [name, setName] = useState("");
  const [path, setPath] = useState<string>("");
  const [browseOpen, setBrowseOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setPath("");
      setBrowseOpen(false);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () => client.createProject({ name: name.trim(), path: path.trim() }),
    onSuccess: ({ project }) => {
      void qc.invalidateQueries({ queryKey: qk.projects() });
      onCreated(project);
      toast(`Project "${project.name}" added`);
    },
    onError: (e) => toast((e as Error).message, true),
  });

  // Auto-derive a name from the path if the user hasn't typed one yet.
  useEffect(() => {
    if (!path) return;
    if (name.trim()) return;
    const base = path.split("/").filter(Boolean).pop();
    if (base) setName(base);
    // intentionally only fires when path changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const valid = !!name.trim() && !!path.trim();

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4 text-ember-500" />
            Add a project
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
              Folder
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setBrowseOpen(true)}
                className="flex-1 flex items-center gap-2 h-9 rounded-md border border-ink-900/15 bg-paper-50 px-2.5 text-left transition-colors hover:bg-paper-100 hover:border-ink-900/25 dark:border-ink-50/15 dark:bg-ink-800 dark:hover:bg-ink-700"
              >
                <FolderGit2 className="h-3.5 w-3.5 text-ink-400 shrink-0 dark:text-ink-500" />
                {path ? (
                  <span className="font-mono text-[11px] text-ink-700 dark:text-ink-200 truncate">
                    {path}
                  </span>
                ) : (
                  <span className="text-[12px] text-ink-500 dark:text-ink-400">
                    Browse…
                  </span>
                )}
                <ChevronDown className="ml-auto h-3.5 w-3.5 text-ink-400 dark:text-ink-500" />
              </button>
            </div>
            <p className="mt-1 text-[11px] text-ink-500 dark:text-ink-400">
              Pick the git repo on the daemon's filesystem.
            </p>
          </div>

          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
              Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auto-derived from folder"
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!valid || create.isPending}
          >
            {create.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Add project
          </Button>
        </DialogFooter>
      </DialogContent>

      <BrowseDialog
        open={browseOpen}
        onClose={() => setBrowseOpen(false)}
        initialPath={path}
        onSelect={(p) => {
          setPath(p);
          setBrowseOpen(false);
        }}
      />
    </Dialog>
  );
}

/* ── Browse-only filesystem picker ─────────────────────────────── */

function BrowseDialog({
  open,
  onClose,
  initialPath,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  initialPath: string;
  onSelect: (path: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4 text-ember-500" />
            Pick a folder
          </DialogTitle>
        </DialogHeader>
        <BrowseBody initialPath={initialPath} onSelect={onSelect} onCancel={onClose} />
      </DialogContent>
    </Dialog>
  );
}

function BrowseBody({
  initialPath,
  onSelect,
  onCancel,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const client = useClient();
  const [path, setPath] = useState<string | null>(initialPath || null);
  const [data, setData] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void client
      .listFs(path ?? undefined)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message);
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, path]);

  const filtered = useMemo(() => {
    const list = data?.entries ?? [];
    if (!filter.trim()) return list;
    const q = filter.toLowerCase();
    return list.filter((e) => e.name.toLowerCase().includes(q));
  }, [data, filter]);

  return (
    <div className="flex h-[420px] flex-col">
      {/* Crumb */}
      <div className="flex items-center gap-2 border-b border-ink-900/10 dark:border-ink-50/10 px-3 py-2">
        <button
          type="button"
          onClick={() => data?.parent && setPath(data.parent)}
          disabled={!data?.parent}
          className="size-7 flex items-center justify-center rounded-md text-ink-500 hover:bg-ink-900/[0.05] hover:text-ink-900 disabled:opacity-30 dark:text-ink-400 dark:hover:bg-ink-50/[0.05] dark:hover:text-ink-50"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <code className="flex-1 truncate font-mono text-[11px] text-ink-700 dark:text-ink-200">
          {data?.path ?? path ?? "/"}
        </code>
        {data?.path && (
          <Button
            size="xs"
            onClick={() => onSelect(data.path)}
            className={cn(!data.isGit && "bg-ink-700 hover:bg-ink-900 dark:bg-ink-600 dark:hover:bg-ink-500")}
            title={data.isGit ? "Use this git repo" : "Use this folder (not a git repo)"}
          >
            <Check className="h-3 w-3" />
            Use this
          </Button>
        )}
      </div>

      {/* Filter */}
      <div className="relative border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3 w-3 text-ink-400 dark:text-ink-500" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter directories…"
          className="h-8 border-0 rounded-none pl-8 text-[12px] focus-visible:ring-0 bg-transparent shadow-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-ink-400" />
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-[11px] text-red-700 dark:text-red-300 break-all">
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-ink-400 dark:text-ink-500">
            {filter ? "No matches" : "Empty directory"}
          </div>
        ) : (
          <ul>
            {filtered.map((e) => (
              <li
                key={e.path}
                className={cn(
                  "group flex items-center gap-2 px-3 h-9 hover:bg-paper-100 dark:hover:bg-ink-700",
                  e.isGit && "bg-ember-500/[0.04] dark:bg-ember-500/[0.06]",
                )}
              >
                {e.isGit ? (
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-ember-500" />
                ) : (
                  <FolderClosed className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                )}
                <button
                  type="button"
                  onClick={() => onSelect(e.path)}
                  title={e.isGit ? "Use this git repo" : "Use this folder"}
                  className="flex-1 min-w-0 text-left truncate font-mono text-[12px] text-ink-700 dark:text-ink-200 hover:text-ember-700 dark:hover:text-ember-300"
                >
                  {e.name}
                </button>
                {e.isGit && (
                  <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ember-700 dark:text-ember-300">
                    git
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setPath(e.path)}
                  aria-label="Open folder"
                  title="Open folder"
                  className="size-6 flex items-center justify-center rounded text-ink-400 hover:text-ink-900 hover:bg-ink-900/[0.05] dark:text-ink-400 dark:hover:text-ink-50 dark:hover:bg-ink-50/[0.05]"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-ink-900/10 bg-paper-50 px-3 py-2 dark:border-ink-50/10 dark:bg-ink-800">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
          Cancel
        </Button>
      </div>
    </div>
  );
}
