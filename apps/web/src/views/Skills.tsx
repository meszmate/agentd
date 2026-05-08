import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  BookText,
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Lock,
  Pencil,
  Play,
  Plus,
  Save,
  Search as SearchIcon,
  Sparkles,
  Terminal as TerminalIcon,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { Skill, SkillScope } from "@agentd/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { ProjectPicker } from "@/components/project-picker";
import {
  qk,
  useCreateSkill,
  useDeleteSkill,
  usePatchPrefs,
  usePrefs,
  useProjects,
  useSkills,
  useUpdateSkill,
} from "@/queries";
import { useApp, useClient } from "@/AppContext";
import { cn, formatTs } from "@/lib/utils";

type ScopeFilter = "all" | SkillScope;

const SCOPE_LABEL: Record<SkillScope, string> = {
  global: "Global",
  local: "Local",
  claude: "Claude",
  codex: "Codex",
};

const SCOPE_TONE: Record<SkillScope, string> = {
  global: "text-ember-700 dark:text-ember-300",
  local: "text-emerald-700 dark:text-emerald-300",
  claude: "text-violet-700 dark:text-violet-300",
  codex: "text-sky-700 dark:text-sky-300",
};

interface FileNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export function Skills({ embedded = false }: { embedded?: boolean } = {}) {
  const projectsQ = useProjects();
  const projects = projectsQ.data?.projects ?? [];

  // Project context for "local" skills. Selecting a project unlocks local
  // skills under <projectPath>/.agents/skills/. The last picked project
  // syncs across devices via server-side prefs.
  const prefsQ = usePrefs();
  const patchPrefs = usePatchPrefs();
  const [projectId, setProjectIdState] = useState<string>("");
  const [projectPath, setProjectPath] = useState<string>("");
  const [projectHydrated, setProjectHydrated] = useState(false);
  useEffect(() => {
    if (projectHydrated) return;
    const id = prefsQ.data?.prefs.lastProjectId;
    if (id == null) return;
    setProjectIdState(id);
    setProjectHydrated(true);
  }, [prefsQ.data, projectHydrated]);
  const setProjectId = (id: string) => {
    setProjectIdState(id);
    void patchPrefs.mutateAsync({ lastProjectId: id });
  };
  useEffect(() => {
    if (!projectId) return;
    const p = projects.find((x) => x.id === projectId);
    if (p) setProjectPath(p.path);
  }, [projectId, projects]);

  const skillsQ = useSkills(projectPath || undefined);
  const skills = skillsQ.data?.skills ?? [];

  const [filter, setFilter] = useState<ScopeFilter>("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Skill | null>(null);

  // Auto-pick the first skill when nothing is selected and the list is non-empty.
  useEffect(() => {
    if (selected) return;
    if (skills.length === 0) return;
    setSelected(skills[0] ?? null);
  }, [selected, skills]);

  // If the selected skill disappears (deleted from elsewhere), drop it.
  useEffect(() => {
    if (!selected) return;
    const still = skills.find(
      (s) => s.scope === selected.scope && s.slug === selected.slug,
    );
    if (!still) setSelected(skills[0] ?? null);
    else if (still.path !== selected.path) setSelected(still);
  }, [skills, selected]);

  const counts = useMemo(() => {
    const c: Record<SkillScope, number> = {
      global: 0,
      local: 0,
      claude: 0,
      codex: 0,
    };
    for (const s of skills) c[s.scope]++;
    return c;
  }, [skills]);

  const filtered = useMemo(() => {
    let xs = skills;
    if (filter !== "all") xs = xs.filter((s) => s.scope === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      xs = xs.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.slug.toLowerCase().includes(q) ||
          (s.displayName ?? "").toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q),
      );
    }
    return xs;
  }, [skills, filter, search]);

  const clearProject = () => {
    setProjectIdState("");
    setProjectPath("");
    void patchPrefs.mutateAsync({ lastProjectId: "" });
    if (filter === "local") setFilter("all");
  };

  const projectControls = (
    <div className="hidden md:flex items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-400 dark:text-ink-500">
        project
      </span>
      <div className="w-56">
        <ProjectPicker
          value={projectId}
          onChange={(p) => {
            setProjectId(p.id);
            setProjectPath(p.path);
          }}
        />
      </div>
      {projectId && (
        <button
          type="button"
          onClick={clearProject}
          title="clear project — show global skills only"
          className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-ink-900/15 text-ink-500 hover:bg-paper-100 hover:text-ink-900 dark:border-ink-50/15 dark:text-ink-400 dark:hover:bg-ink-700 dark:hover:text-ink-50"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  const header = embedded ? (
    <div className="flex h-9 items-center gap-2 px-4 border-b border-ink-900/10 dark:border-ink-50/10 shrink-0 bg-paper-100 dark:bg-ink-800">
      <Kicker>library</Kicker>
      <VRule />
      <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
        Skills
      </span>
      <span className="text-ink-300 dark:text-ink-600">·</span>
      <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 tabular-nums">
        {skills.length} total
      </span>
      <Spacer />
      {projectControls}
      <Button size="xs" onClick={() => setCreateOpen(true)}>
        <Plus className="h-3 w-3" /> New skill
      </Button>
    </div>
  ) : (
    <PageTopbar>
      <Kicker>library</Kicker>
      <VRule />
      <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
        Skills
      </span>
      <span className="text-ink-300 dark:text-ink-600">·</span>
      <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 tabular-nums">
        {skills.length} total
      </span>
      <Spacer />
      {projectControls}
      <Button size="xs" onClick={() => setCreateOpen(true)}>
        <Plus className="h-3 w-3" /> New skill
      </Button>
    </PageTopbar>
  );

  return (
    <div className="flex h-full flex-col">
      {header}

      {/* Master-detail body */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[300px_1fr]">
        {/* Master: skill list */}
        <aside className="flex flex-col min-h-0 border-r border-ink-900/10 dark:border-ink-50/10 bg-paper-50 dark:bg-ink-800">
          <div className="flex items-center gap-2 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] px-3 py-2">
            <SearchIcon className="h-3 w-3 text-ink-400 dark:text-ink-500 shrink-0" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filter…"
              className="h-7 border-0 px-0 text-[12px] focus-visible:ring-0 bg-transparent shadow-none"
            />
          </div>

          <div className="flex items-center gap-1 px-2 py-2 overflow-x-auto border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
            <ScopePill
              label="All"
              count={skills.length}
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            {(["local", "global", "claude", "codex"] as const).map((s) => (
              <ScopePill
                key={s}
                label={SCOPE_LABEL[s]}
                count={counts[s]}
                tone={SCOPE_TONE[s]}
                active={filter === s}
                onClick={() => setFilter(s)}
                disabled={s === "local" && !projectPath}
              />
            ))}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {skillsQ.isLoading && !skillsQ.data ? (
              <div className="flex items-center justify-center py-10 text-[12px] text-ink-500 dark:text-ink-400">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : filtered.length === 0 ? (
              <SidebarEmpty
                hasAny={skills.length > 0}
                projectPath={projectPath}
                onCreate={() => setCreateOpen(true)}
              />
            ) : (
              <ul>
                {filtered.map((s) => {
                  const isActive =
                    !!selected &&
                    s.scope === selected.scope &&
                    s.slug === selected.slug;
                  return (
                    <li key={`${s.scope}:${s.slug}`}>
                      <button
                        type="button"
                        onClick={() => setSelected(s)}
                        className={cn(
                          "group w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors",
                          isActive
                            ? "bg-ember-500/10"
                            : "hover:bg-paper-100 dark:hover:bg-ink-700",
                        )}
                      >
                        <BookText
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 mt-0.5",
                            isActive
                              ? "text-ember-500"
                              : "text-ink-400 dark:text-ink-500",
                          )}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-[13px] font-medium text-ink-900 dark:text-ink-50 truncate">
                              {s.displayName ?? s.name}
                            </span>
                            {!s.writable && (
                              <Lock className="h-2.5 w-2.5 text-ink-400 dark:text-ink-500 shrink-0" />
                            )}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                            <span
                              className={cn(
                                "font-mono uppercase tracking-[0.12em]",
                                SCOPE_TONE[s.scope],
                              )}
                            >
                              {s.scope}
                            </span>
                            <span className="font-mono text-ink-400 dark:text-ink-500 truncate">
                              {s.slug}
                            </span>
                          </div>
                          {s.description && (
                            <p className="mt-1 text-[11px] text-ink-500 dark:text-ink-400 line-clamp-2 leading-snug">
                              {s.description}
                            </p>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* Detail: selected skill */}
        <main className="min-h-0 min-w-0">
          {selected ? (
            <SkillDetail
              skill={selected}
              repoPath={projectPath || undefined}
              onDeleted={() => setSelected(null)}
            />
          ) : (
            <DetailEmpty onCreate={() => setCreateOpen(true)} />
          )}
        </main>
      </div>

      <CreateSkillSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultRepoPath={projectPath}
        onCreated={(s) => setSelected(s)}
      />
    </div>
  );
}

function ScopePill({
  label,
  count,
  active,
  onClick,
  tone,
  disabled,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 h-6 px-2 rounded-md border text-[11px] transition-colors",
        active
          ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
          : "border-ink-900/10 bg-paper-100 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-900/40 dark:text-ink-400 dark:hover:text-ink-50",
        disabled && "opacity-40 cursor-not-allowed hover:border-ink-900/10 hover:text-ink-500",
      )}
    >
      <span className={cn("font-mono", !active && tone)}>{label}</span>
      <span className="font-mono tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function SidebarEmpty({
  hasAny,
  projectPath,
  onCreate,
}: {
  hasAny: boolean;
  projectPath: string;
  onCreate: () => void;
}) {
  return (
    <div className="px-3 py-6 text-center">
      <BookText className="h-6 w-6 mx-auto text-ink-300 dark:text-ink-600" />
      <p className="mt-2 text-[12px] text-ink-500 dark:text-ink-400">
        {hasAny ? "no matches" : "no skills yet"}
      </p>
      {!hasAny && (
        <>
          <p className="mt-2 text-[10px] text-ink-400 dark:text-ink-500 leading-relaxed">
            Drop a SKILL.md into{" "}
            <code className="font-mono text-[10px]">~/.agentd/skills/&lt;name&gt;/</code>
            {projectPath && (
              <> or <code className="font-mono text-[10px]">{projectPath}/.agents/skills/&lt;name&gt;/</code></>
            )}
            , or:
          </p>
          <Button size="xs" onClick={onCreate} className="mt-2">
            <Plus className="h-3 w-3" /> New skill
          </Button>
        </>
      )}
    </div>
  );
}

function DetailEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="text-center max-w-md">
        <Sparkles className="h-8 w-8 mx-auto text-ink-300 dark:text-ink-600" />
        <p className="mt-3 text-[14px] font-medium text-ink-900 dark:text-ink-50">
          No skill selected
        </p>
        <p className="mt-1 text-[12px] text-ink-500 dark:text-ink-400 leading-relaxed">
          Pick one on the left to inspect, edit, or run its bundled scripts.
          Skills are markdown files (plus optional helper scripts) that get
          appended to the agent's system prompt when activated.
        </p>
        <Button size="sm" onClick={onCreate} className="mt-3">
          <Plus className="h-3.5 w-3.5" /> New skill
        </Button>
      </div>
    </div>
  );
}

/* ── Detail pane ─────────────────────────────────────────────────── */

interface OpenFile {
  path: string;
  content: string;
  binary: boolean;
  size: number;
  /** Edited but not yet saved. */
  dirty: boolean;
}

function SkillDetail({
  skill,
  repoPath,
  onDeleted,
}: {
  skill: Skill;
  repoPath: string | undefined;
  onDeleted: () => void;
}) {
  const client = useClient();
  const qc = useQueryClient();
  const { toast } = useApp();
  const update = useUpdateSkill();
  const del = useDeleteSkill();

  // Tree of files in the skill's directory (excluding the skill itself we
  // surface directly via PATCH /skills/:scope/:slug).
  const filesQ = useQuery({
    queryKey: ["skills", skill.scope, skill.slug, "files", repoPath ?? ""],
    queryFn: () =>
      client.listSkillFiles(skill.scope, skill.slug, repoPath || undefined),
    staleTime: 10_000,
  });

  // Currently-open file in the editor. SKILL.md routes through PATCH for
  // frontmatter handling; everything else uses raw read/write.
  const [openPath, setOpenPath] = useState<string>("SKILL.md");
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [meta, setMeta] = useState({
    displayName: skill.displayName ?? "",
    description: skill.description ?? "",
  });
  const [showMeta, setShowMeta] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  // Reset when the user navigates to a different skill.
  useEffect(() => {
    setOpenPath("SKILL.md");
    setOpen({
      path: "SKILL.md",
      content: skill.body,
      binary: false,
      size: skill.body.length,
      dirty: false,
    });
    setMeta({
      displayName: skill.displayName ?? "",
      description: skill.description ?? "",
    });
    setShowMeta(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.scope, skill.slug, skill.path]);

  // Load file content on tab change (skip SKILL.md — already loaded from skill.body).
  useEffect(() => {
    let cancelled = false;
    if (openPath === "SKILL.md") {
      setOpen({
        path: "SKILL.md",
        content: skill.body,
        binary: false,
        size: skill.body.length,
        dirty: false,
      });
      return;
    }
    void client
      .readSkillFile(skill.scope, skill.slug, openPath, repoPath || undefined)
      .then((r) => {
        if (cancelled) return;
        setOpen({
          path: openPath,
          content: r.content,
          binary: r.binary,
          size: r.size,
          dirty: false,
        });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        toast(e.message, true);
        setOpen(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPath, skill.scope, skill.slug, skill.path, repoPath]);

  const tree = filesQ.data?.files ?? [];
  const dir = filesQ.data?.dir ?? skill.path.replace(/\/SKILL\.md$/, "");

  const saveCurrent = async () => {
    if (!open || !skill.writable) return;
    try {
      if (open.path === "SKILL.md") {
        await update.mutateAsync({
          scope: skill.scope,
          slug: skill.slug,
          patch: {
            body: open.content,
            displayName: meta.displayName || undefined,
            description: meta.description || undefined,
          },
          repoPath,
        });
      } else {
        await client.writeSkillFile(
          skill.scope,
          skill.slug,
          open.path,
          open.content,
          repoPath || undefined,
        );
        void qc.invalidateQueries({
          queryKey: ["skills", skill.scope, skill.slug, "files"],
        });
      }
      setOpen({ ...open, dirty: false });
      toast(`saved ${open.path}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const removeSkill = async () => {
    if (!confirm(`Delete skill ${skill.scope}:${skill.slug}? This wipes the directory.`)) return;
    try {
      await del.mutateAsync({
        scope: skill.scope,
        slug: skill.slug,
        repoPath,
      });
      toast(`deleted ${skill.scope}:${skill.slug}`);
      onDeleted();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const removeFile = async (path: string) => {
    if (path === "SKILL.md") return;
    if (!confirm(`Delete ${path}?`)) return;
    try {
      await client.deleteSkillFile(
        skill.scope,
        skill.slug,
        path,
        repoPath || undefined,
      );
      void qc.invalidateQueries({
        queryKey: ["skills", skill.scope, skill.slug, "files"],
      });
      if (openPath === path) setOpenPath("SKILL.md");
      toast(`deleted ${path}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const addFile = async (relPath: string, content: string) => {
    try {
      await client.writeSkillFile(
        skill.scope,
        skill.slug,
        relPath,
        content,
        repoPath || undefined,
      );
      await qc.invalidateQueries({
        queryKey: ["skills", skill.scope, skill.slug, "files"],
      });
      setOpenPath(relPath);
      toast(`created ${relPath}`);
    } catch (e) {
      toast((e as Error).message, true);
      throw e;
    }
  };

  const tmuxName = `skill-${skill.scope}-${skill.slug}`;
  const onOpenInTmux = async () => {
    try {
      await client.createTerminalSession({ name: tmuxName, cwd: dir });
    } catch (e) {
      // Already-exists is fine — we'll just attach.
      const msg = (e as Error).message;
      if (!/already exists|tmux failed/i.test(msg)) {
        toast(msg, true);
        return;
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header strip */}
      <div className="flex items-center gap-3 border-b border-ink-900/10 dark:border-ink-50/10 px-5 py-3 shrink-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-semibold text-ink-900 dark:text-ink-50 truncate">
              {skill.displayName ?? skill.name}
            </h2>
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-[0.12em]",
                SCOPE_TONE[skill.scope],
              )}
            >
              {skill.scope}
            </span>
            <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 truncate">
              {skill.slug}
            </span>
            {!skill.writable && (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-400 dark:text-ink-500">
                <Lock className="h-2.5 w-2.5" /> read-only
              </span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-ink-500 dark:text-ink-400 truncate">
            {dir}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            size="xs"
            variant="outline"
            onClick={() => setShowMeta((v) => !v)}
            disabled={!skill.writable}
            title="edit name + description (frontmatter)"
          >
            <Pencil className="h-3 w-3" />
            Meta
          </Button>
          <Link
            to={`/terminal/${encodeURIComponent(tmuxName)}`}
            onClick={onOpenInTmux}
            className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-ember-500/30 bg-ember-500/10 text-[11px] text-ember-700 hover:bg-ember-500/20 dark:text-ember-300 transition-colors"
            title="open a tmux session at this skill's directory"
          >
            <TerminalIcon className="h-3 w-3" />
            Open shell
          </Link>
          {skill.writable && (
            <Button
              variant="ghost"
              size="xs"
              onClick={removeSkill}
              disabled={del.isPending}
              className="text-red-700 dark:text-red-300"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Optional metadata editor */}
      {showMeta && skill.writable && (
        <div className="border-b border-ink-900/[0.06] bg-paper-100/40 dark:border-ink-50/[0.06] dark:bg-ink-900/30 px-5 py-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
              Display name
            </Label>
            <Input
              value={meta.displayName}
              onChange={(e) => {
                setMeta({ ...meta, displayName: e.target.value });
                setOpen((cur) => (cur ? { ...cur, dirty: true } : cur));
              }}
              placeholder="optional"
            />
          </div>
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
              Description
            </Label>
            <Input
              value={meta.description}
              onChange={(e) => {
                setMeta({ ...meta, description: e.target.value });
                setOpen((cur) => (cur ? { ...cur, dirty: true } : cur));
              }}
              placeholder="one-line summary the agent sees"
            />
          </div>
        </div>
      )}

      {/* Body: file tree + editor */}
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[240px_1fr]">
        {/* File tree */}
        <div className="flex flex-col min-h-0 border-r border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-50/60 dark:bg-ink-900/30">
          <div className="flex items-center justify-between px-3 py-2 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
              Files
            </span>
            {skill.writable && (
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="text-[10px] font-mono uppercase tracking-[0.12em] text-ember-700 hover:underline dark:text-ember-300"
              >
                + add
              </button>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <FileTree
              tree={[
                {
                  path: "SKILL.md",
                  name: "SKILL.md",
                  isDir: false,
                  size: skill.body.length,
                  mtime: 0,
                },
                ...tree,
              ]}
              activePath={openPath}
              onSelect={(p) => setOpenPath(p)}
              onDelete={skill.writable ? removeFile : undefined}
            />
          </div>
        </div>

        {/* Editor */}
        <div className="flex flex-col min-h-0">
          {open ? (
            <FileEditor
              open={open}
              onChange={(content) =>
                setOpen({ ...open, content, dirty: content !== open.content || open.dirty })
              }
              writable={skill.writable}
              dirty={open.dirty}
              onSave={saveCurrent}
              saving={update.isPending}
              skill={skill}
            />
          ) : (
            <div className="flex-1 grid place-items-center text-[12px] text-ink-500 dark:text-ink-400">
              loading…
            </div>
          )}
        </div>
      </div>

      <AddFileDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        existing={tree.map((f) => f.path)}
        onAdd={async (path, content) => {
          await addFile(path, content);
          setAddOpen(false);
        }}
      />
    </div>
  );
}

/* ── File tree ────────────────────────────────────────────────────── */

function FileTree({
  tree,
  activePath,
  onSelect,
  onDelete,
}: {
  tree: FileNode[];
  activePath: string;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
}) {
  // Build a nested structure from flat list.
  const root = useMemo(() => buildTree(tree), [tree]);
  return (
    <ul className="py-1">
      {root.children.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  children: TreeNode[];
}

function buildTree(nodes: FileNode[]): TreeNode {
  const root: TreeNode = {
    path: "",
    name: "",
    isDir: true,
    size: 0,
    mtime: 0,
    children: [],
  };
  const map = new Map<string, TreeNode>();
  map.set("", root);
  // Ensure parent dirs come before children — sort by path depth then name.
  const sorted = [...nodes].sort((a, b) => {
    const ad = a.path.split("/").length;
    const bd = b.path.split("/").length;
    if (ad !== bd) return ad - bd;
    return a.path.localeCompare(b.path);
  });
  for (const n of sorted) {
    const parts = n.path.split("/");
    const name = parts.pop()!;
    const parentPath = parts.join("/");
    let parent = map.get(parentPath);
    if (!parent) {
      // Synthesize missing parent dirs (shouldn't happen with our backend
      // but be defensive).
      let walk = "";
      for (const p of parts) {
        const next = walk ? `${walk}/${p}` : p;
        if (!map.has(next)) {
          const node: TreeNode = {
            path: next,
            name: p,
            isDir: true,
            size: 0,
            mtime: 0,
            children: [],
          };
          map.get(walk)!.children.push(node);
          map.set(next, node);
        }
        walk = next;
      }
      parent = map.get(parentPath)!;
    }
    const node: TreeNode = { ...n, name, children: [] };
    parent.children.push(node);
    map.set(n.path, node);
  }
  // Dirs first within each level.
  const sortChildren = (n: TreeNode): void => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) sortChildren(c);
  };
  sortChildren(root);
  return root;
}

function TreeNode({
  node,
  depth,
  activePath,
  onSelect,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  activePath: string;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (node.isDir) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group flex w-full items-center gap-1 px-2 py-1 text-left hover:bg-paper-100 dark:hover:bg-ink-700"
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 text-ink-400 dark:text-ink-500" />
          ) : (
            <ChevronRight className="h-3 w-3 text-ink-400 dark:text-ink-500" />
          )}
          {open ? (
            <FolderOpen className="h-3.5 w-3.5 text-ember-500" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-ember-500" />
          )}
          <span className="font-mono text-[11px] text-ink-700 dark:text-ink-200 truncate">
            {node.name}
          </span>
        </button>
        {open && (
          <ul>
            {node.children.map((c) => (
              <TreeNode
                key={c.path}
                node={c}
                depth={depth + 1}
                activePath={activePath}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }
  const isActive = node.path === activePath;
  const Icon = iconForFile(node.name);
  return (
    <li>
      <div
        className={cn(
          "group flex items-center gap-1 px-2 py-1",
          isActive
            ? "bg-ember-500/10"
            : "hover:bg-paper-100 dark:hover:bg-ink-700",
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <span className="w-3" />
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          className={cn(
            "flex-1 flex items-center gap-1 min-w-0 text-left",
            isActive
              ? "text-ember-700 dark:text-ember-300"
              : "text-ink-700 dark:text-ink-200 hover:text-ink-900 dark:hover:text-ink-50",
          )}
        >
          <Icon
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              isActive
                ? "text-ember-500"
                : "text-ink-400 dark:text-ink-500",
            )}
          />
          <span className="font-mono text-[11px] truncate">{node.name}</span>
        </button>
        {onDelete && node.path !== "SKILL.md" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(node.path);
            }}
            className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-ink-400 hover:bg-ink-900/10 hover:text-red-700 dark:hover:bg-ink-50/10 dark:hover:text-red-300 transition-opacity"
            title="delete"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    </li>
  );
}

function iconForFile(name: string): typeof FileIcon {
  if (/\.(md|markdown|txt)$/i.test(name)) return FileText;
  if (/\.(sh|bash|zsh|py|rb|js|ts|tsx|mjs|cjs|json|yaml|yml|toml)$/i.test(name)) {
    return FileCode;
  }
  return FileIcon;
}

/* ── Editor ───────────────────────────────────────────────────────── */

function FileEditor({
  open,
  onChange,
  writable,
  dirty,
  onSave,
  saving,
  skill,
}: {
  open: OpenFile;
  onChange: (content: string) => void;
  writable: boolean;
  dirty: boolean;
  onSave: () => void;
  saving: boolean;
  skill: Skill;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Cmd/Ctrl+S to save.
  useEffect(() => {
    if (!writable) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        onSave();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [writable, onSave]);

  const isExecutable = /\.(sh|bash|zsh|py|rb)$/i.test(open.path);
  const tmuxName = `skill-${skill.scope}-${skill.slug}`;

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06] bg-paper-100/40 dark:bg-ink-900/30 px-3 py-1.5 shrink-0">
        <span className="font-mono text-[11px] text-ink-700 dark:text-ink-200 truncate">
          {open.path}
        </span>
        {dirty && (
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">
            unsaved
          </span>
        )}
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
          {(open.size || open.content.length).toLocaleString()} B
        </span>
        <Spacer />
        {isExecutable && (
          <Link
            to={`/terminal/${encodeURIComponent(tmuxName)}`}
            title={`Open a tmux session here, then run: ./${open.path}`}
            className="inline-flex items-center gap-1 h-5 px-1.5 rounded font-mono text-[10px] text-ember-700 hover:bg-ember-500/10 dark:text-ember-300"
          >
            <Play className="h-3 w-3" />
            run
          </Link>
        )}
        {writable && (
          <Button
            size="xs"
            onClick={onSave}
            disabled={saving || !dirty}
            title={dirty ? "save (⌘S)" : "no changes"}
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            Save
          </Button>
        )}
      </div>
      {open.binary ? (
        <div className="flex-1 grid place-items-center text-[12px] text-ink-500 dark:text-ink-400 px-6 text-center">
          Binary or large file ({open.size.toLocaleString()} bytes) — open in your editor
          via "Open shell".
        </div>
      ) : (
        <Textarea
          ref={taRef}
          value={open.content}
          onChange={(e) => onChange(e.target.value)}
          readOnly={!writable}
          spellCheck={false}
          className="flex-1 border-0 rounded-none focus-visible:ring-0 resize-none bg-paper-50 dark:bg-ink-900/20 font-mono text-[12px] leading-relaxed px-4 py-3 shadow-none"
        />
      )}
    </div>
  );
}

/* ── Add-file dialog ─────────────────────────────────────────────── */

function AddFileDialog({
  open,
  onClose,
  existing,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  existing: string[];
  onAdd: (path: string, content: string) => Promise<void>;
}) {
  const [path, setPath] = useState("scripts/run.sh");
  const [content, setContent] = useState("#!/usr/bin/env bash\nset -euo pipefail\n\n");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) {
      setPath("scripts/run.sh");
      setContent("#!/usr/bin/env bash\nset -euo pipefail\n\n");
      setPending(false);
    }
  }, [open]);

  const conflict = existing.includes(path.trim());
  const valid = path.trim() && path.trim() !== "SKILL.md" && !conflict;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New file</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
              Path (relative to skill dir)
            </Label>
            <Input
              autoFocus
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="scripts/run.sh"
              className="font-mono"
              spellCheck={false}
            />
            {conflict && (
              <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                already exists
              </p>
            )}
            {path === "SKILL.md" && (
              <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                edit SKILL.md from the main editor
              </p>
            )}
          </div>
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-[0.12em]">
              Initial content
            </Label>
            <Textarea
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || pending}
            onClick={async () => {
              setPending(true);
              try {
                await onAdd(path.trim(), content);
              } catch {
                // toast already raised by caller
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Create skill sheet ──────────────────────────────────────────── */

function CreateSkillSheet({
  open,
  onClose,
  defaultRepoPath,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  defaultRepoPath: string;
  onCreated: (s: Skill) => void;
}) {
  const create = useCreateSkill();
  const { toast } = useApp();
  const [scope, setScope] = useState<"global" | "local">("global");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setDisplayName("");
      setDescription("");
      setBody("");
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      toast("name required", true);
      return;
    }
    if (scope === "local" && !defaultRepoPath) {
      toast("local skills need a project — pick one in the topbar", true);
      return;
    }
    try {
      const res = await create.mutateAsync({
        scope,
        name: name.trim(),
        displayName: displayName.trim() || undefined,
        description: description.trim() || undefined,
        body,
        ...(scope === "local" ? { repoPath: defaultRepoPath } : {}),
      });
      toast(`Created ${scope}:${name}`);
      onCreated(res.skill);
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-lg">
        <SheetHeader className="px-6 pt-5">
          <SheetTitle>New skill</SheetTitle>
          <SheetDescription>
            Markdown plus optional helper scripts. The body becomes part of
            the agent's system prompt when activated for a task.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 pb-2 pt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sk-scope">Scope</Label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v as "global" | "local")}
              >
                <SelectTrigger id="sk-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">global · per-server</SelectItem>
                  <SelectItem value="local" disabled={!defaultRepoPath}>
                    local · per-project
                  </SelectItem>
                </SelectContent>
              </Select>
              {scope === "local" && (
                <p className="mt-1 text-[10px] text-ink-500 dark:text-ink-400 truncate">
                  {defaultRepoPath || "select a project to enable"}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="sk-name">Name (slug)</Label>
              <Input
                id="sk-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="review-pr"
                spellCheck={false}
                className="font-mono"
                autoFocus
              />
            </div>
          </div>

          <div>
            <Label htmlFor="sk-display">Display name</Label>
            <Input
              id="sk-display"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="optional"
            />
          </div>
          <div>
            <Label htmlFor="sk-desc">Description</Label>
            <Input
              id="sk-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="one-line summary"
            />
          </div>
          <div>
            <Label htmlFor="sk-body">Body</Label>
            <Textarea
              id="sk-body"
              rows={10}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="You are a careful PR reviewer. When invoked, …"
              className="font-mono text-xs"
            />
          </div>
        </div>

        <SheetFooter className="border-t border-ink-900/10 bg-paper-50 dark:border-ink-50/10 dark:bg-ink-800 px-6 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Create
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

void Upload;
void ArrowUpRight;
void formatTs;
void qk;
