import { useEffect, useMemo, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronRight,
  FolderClosed,
  FolderGit2,
  Loader2,
  Search as SearchIcon,
  Star,
  StarOff,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useClient } from "@/AppContext";
import { usePatchPrefs, usePrefs, useTasks } from "@/queries";
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


export function RepoPicker({
  value,
  onChange,
  placeholder = "/path/to/repo",
  id,
  autoFocus,
}: {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  id?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-2 w-full">
      <div className="relative flex-1 min-w-0">
        <FolderGit2 className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ink-400 dark:text-ink-500" />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          spellCheck={false}
          className="pl-8 font-mono text-xs"
        />
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="h-9 px-3 rounded-md border border-ink-900/15 bg-paper-50 text-[12px] font-medium text-ink-700 hover:bg-paper-200 hover:border-ink-900/30 transition-colors dark:border-ink-50/15 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700"
          >
            Browse…
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-[440px] p-0 overflow-hidden"
          sideOffset={4}
        >
          <PickerBody
            initialPath={value}
            onSelect={(p) => {
              onChange(p);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function PickerBody({
  initialPath,
  onSelect,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
}) {
  const client = useClient();
  const tasksQ = useTasks();
  const [path, setPath] = useState<string | null>(initialPath || null);
  const [data, setData] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const prefsQ = usePrefs();
  const patchPrefs = usePatchPrefs();
  const [pins, setPins] = useState<string[]>([]);
  const [pinsHydrated, setPinsHydrated] = useState(false);
  useEffect(() => {
    if (pinsHydrated) return;
    const p = prefsQ.data?.prefs.repoPickerPins;
    if (!p) return;
    setPins(p);
    setPinsHydrated(true);
  }, [prefsQ.data, pinsHydrated]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void client
      .listFs(path ?? undefined)
      .then((r) => {
        if (cancelled) return;
        setData(r);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, path]);

  const recents = useMemo(() => {
    const seen = new Map<string, number>();
    for (const t of tasksQ.data?.tasks ?? []) {
      const cur = seen.get(t.repoPath) ?? 0;
      seen.set(t.repoPath, Math.max(cur, t.createdAt));
    }
    const list = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p);
    return list.filter((p) => !pins.includes(p)).slice(0, 5);
  }, [tasksQ.data, pins]);

  const filteredEntries = useMemo(() => {
    const list = data?.entries ?? [];
    if (!filter.trim()) return list;
    const q = filter.toLowerCase();
    return list.filter((e) => e.name.toLowerCase().includes(q));
  }, [data, filter]);

  const togglePin = (p: string) => {
    setPins((cur) => {
      const next = cur.includes(p)
        ? cur.filter((x) => x !== p)
        : [p, ...cur].slice(0, 12);
      void patchPrefs.mutateAsync({ repoPickerPins: next });
      return next;
    });
  };

  return (
    <div className="flex h-[400px] flex-col">
      {/* Crumb + filter */}
      <div className="flex items-center gap-2 border-b border-ink-900/10 dark:border-ink-50/10 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => data?.parent && setPath(data.parent)}
          disabled={!data?.parent}
          aria-label="Up"
          className="size-7 flex items-center justify-center rounded-md text-ink-500 hover:bg-ink-900/[0.05] hover:text-ink-900 disabled:opacity-30 disabled:hover:bg-transparent dark:text-ink-400 dark:hover:bg-ink-50/[0.05] dark:hover:text-ink-50"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <code className="flex-1 truncate font-mono text-xs text-ink-700 dark:text-ink-200">
          {data?.path ?? path ?? "/"}
        </code>
        {data?.path && (
          <button
            type="button"
            onClick={() => onSelect(data.path)}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium !text-white",
              data.isGit
                ? "bg-ember-500 hover:bg-ember-600"
                : "bg-ink-700 hover:bg-ink-900 dark:bg-ink-600 dark:hover:bg-ink-500",
            )}
            title={data.isGit ? "Use this git repo" : "Use this folder (not a git repo)"}
          >
            <Check className="h-3 w-3" /> Use this
          </button>
        )}
      </div>

      <div className="relative border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3 w-3 text-ink-400 dark:text-ink-500" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter directories…"
          className="h-8 border-0 rounded-none pl-8 text-[12px] focus-visible:ring-0 bg-transparent shadow-none"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Pinned */}
        {pins.length > 0 && filter.trim() === "" && (
          <Section heading="Pinned">
            {pins.map((p) => (
              <Row
                key={p}
                label={p}
                onSelect={() => onSelect(p)}
                onNavigate={() => setPath(p)}
                pinned
                onTogglePin={() => togglePin(p)}
                glyph="git"
              />
            ))}
          </Section>
        )}

        {/* Recents (from task history) */}
        {recents.length > 0 && filter.trim() === "" && (
          <Section heading="Recent">
            {recents.map((p) => (
              <Row
                key={p}
                label={p}
                onSelect={() => onSelect(p)}
                onNavigate={() => setPath(p)}
                pinned={false}
                onTogglePin={() => togglePin(p)}
                glyph="git"
              />
            ))}
          </Section>
        )}

        {/* Browse */}
        <Section heading="Browse">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-ink-400" />
            </div>
          ) : error ? (
            <div className="px-3 py-3 text-[11px] text-red-700 dark:text-red-300 break-all">
              {error}
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-ink-400 dark:text-ink-500">
              {filter ? "No matches" : "Empty directory"}
            </div>
          ) : (
            filteredEntries.map((e) => (
              <DirRow
                key={e.path}
                entry={e}
                onNavigate={() => setPath(e.path)}
                onSelect={() => onSelect(e.path)}
              />
            ))
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="sticky top-0 bg-paper-200 dark:bg-ink-800 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 z-10">
        {heading}
      </div>
      {children}
    </div>
  );
}

function Row({
  label,
  onSelect,
  onNavigate,
  pinned,
  onTogglePin,
  glyph,
}: {
  label: string;
  onSelect: () => void;
  onNavigate: () => void;
  pinned: boolean;
  onTogglePin: () => void;
  glyph: "git" | "dir";
}) {
  return (
    <div className="group flex items-center gap-2 px-3 h-9 hover:bg-paper-100 dark:hover:bg-ink-700">
      {glyph === "git" ? (
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-ember-500" />
      ) : (
        <FolderClosed className="h-3.5 w-3.5 shrink-0 text-ink-400" />
      )}
      <button
        type="button"
        onClick={onSelect}
        title="Use this repo"
        className="flex-1 min-w-0 text-left truncate font-mono text-[11px] text-ink-700 hover:text-ember-700 dark:text-ink-200 dark:hover:text-ember-300"
      >
        {label}
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        aria-label={pinned ? "Unpin" : "Pin"}
        className="size-6 flex items-center justify-center rounded text-ink-400 hover:text-ember-500"
      >
        {pinned ? (
          <Star className="h-3 w-3 fill-ember-500 text-ember-500" />
        ) : (
          <StarOff className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
        )}
      </button>
      <button
        type="button"
        onClick={onNavigate}
        aria-label="Browse into"
        className="size-6 flex items-center justify-center rounded text-ink-400 hover:text-ink-900 hover:bg-ink-900/[0.05] dark:text-ink-400 dark:hover:text-ink-50 dark:hover:bg-ink-50/[0.05]"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function DirRow({
  entry,
  onNavigate,
  onSelect,
}: {
  entry: FsEntry;
  onNavigate: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-3 h-9 hover:bg-paper-100 dark:hover:bg-ink-700",
        entry.isGit && "bg-ember-500/[0.04] dark:bg-ember-500/[0.06]",
      )}
    >
      {entry.isGit ? (
        <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-ember-500" />
      ) : (
        <FolderClosed className="h-3.5 w-3.5 shrink-0 text-ink-400" />
      )}
      {/* Whole-row click = select. Chevron on the right navigates into the
          folder. Non-git dirs are still selectable — the daemon will return
          a clear error if it can't worktree there, and that's better than
          a silent dead-end click. */}
      <button
        type="button"
        onClick={onSelect}
        title={entry.isGit ? "Use this repo" : "Pick this folder"}
        className="flex-1 min-w-0 text-left truncate font-mono text-[12px] text-ink-700 dark:text-ink-200 hover:text-ember-700 dark:hover:text-ember-300"
      >
        {entry.name}
      </button>
      {entry.isGit ? (
        <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ember-700 dark:text-ember-300">
          git
        </span>
      ) : (
        <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-300 dark:text-ink-600">
          dir
        </span>
      )}
      <button
        type="button"
        onClick={onNavigate}
        aria-label="Open folder"
        title="Open folder"
        className="size-6 flex items-center justify-center rounded text-ink-400 hover:text-ink-900 hover:bg-ink-900/[0.05] dark:text-ink-400 dark:hover:text-ink-50 dark:hover:bg-ink-50/[0.05]"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
