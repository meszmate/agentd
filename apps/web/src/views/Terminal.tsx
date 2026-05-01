import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  Check,
  Pencil,
  Plus,
  Terminal as TerminalIcon,
  Trash2,
  X,
  Users,
  Copy,
} from "lucide-react";
import { useApp, useClient } from "@/AppContext";
import { XTermPane } from "@/components/xterm-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatTs } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

const SESSIONS_KEY = ["terminal", "sessions"] as const;
const windowsKey = (name: string) =>
  ["terminal", "sessions", name, "windows"] as const;

const NAME_RE = /^[a-zA-Z0-9_.\-: ]{1,64}$/;

/**
 * Per-task shell — kept around for the existing Task workspace tab. Just a
 * thin XTermPane wrapper that opens /pty/:taskId.
 */
export function Terminal({
  taskId,
  onError,
}: {
  taskId: string;
  onError: (m: string) => void;
}) {
  const client = useClient();
  const connect = useCallback(() => client.attachTask(taskId), [client, taskId]);
  return (
    <XTermPane
      connect={connect}
      connectionKey={`task:${taskId}`}
      onError={onError}
    />
  );
}

/**
 * Global Terminal page. Persistent tmux sessions on the daemon, attached via
 * xterm.js. Multiple browser tabs can attach to the same session and stay in
 * sync (tmux mirrors the view).
 *
 * Routes:
 *   /terminal              → empty / "create session" state
 *   /terminal/:sessionName → attached pane
 */
export function TerminalView() {
  const { sessionName } = useParams<{ sessionName?: string }>();
  const client = useClient();
  const { toast } = useApp();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Sessions list is kept fresh by the WS push (see realtime.tsx). The slow
  // refetch interval is just a safety net in case the socket drops.
  const { data, isLoading } = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => client.listTerminalSessions(),
    refetchInterval: 30_000,
    staleTime: 30_000,
  });

  const sessions = data?.sessions ?? [];
  const active = sessionName
    ? sessions.find((s) => s.name === sessionName)
    : null;

  const create = useMutation({
    mutationFn: (req: { name: string; cwd?: string }) =>
      client.createTerminalSession(req),
    onSuccess: ({ session }) => {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      navigate(`/terminal/${encodeURIComponent(session.name)}`);
      setShowNew(false);
    },
    onError: (e) => toast(`create: ${(e as Error).message}`, true),
  });

  const kill = useMutation({
    mutationFn: (name: string) => client.killTerminalSession(name),
    onSuccess: (_r, name) => {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      if (sessionName === name) navigate("/terminal");
      toast(`Killed ${name}`);
    },
    onError: (e) => toast(`kill: ${(e as Error).message}`, true),
  });

  const rename = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      client.renameTerminalSession(from, { name: to }),
    onSuccess: (_r, { from, to }) => {
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      setRenaming(null);
      if (sessionName === from) {
        navigate(`/terminal/${encodeURIComponent(to)}`, { replace: true });
      }
    },
    onError: (e) => toast(`rename: ${(e as Error).message}`, true),
  });

  const connect = useCallback(() => {
    if (!sessionName) return null;
    return client.attachTerminal(sessionName);
  }, [client, sessionName]);

  const onCopyAttachCmd = useCallback(() => {
    if (!sessionName) return;
    const cmd = `tmux attach -t ${sessionName}`;
    void navigator.clipboard.writeText(cmd).catch(() => {});
    toast(`copied: ${cmd}`);
  }, [sessionName, toast]);

  const beginRename = useCallback((name: string) => {
    setRenaming(name);
    setRenameDraft(name);
  }, []);

  const submitRename = useCallback(() => {
    if (!renaming) return;
    const to = renameDraft.trim();
    if (!to || to === renaming) {
      setRenaming(null);
      return;
    }
    if (!NAME_RE.test(to)) {
      toast("invalid name", true);
      return;
    }
    rename.mutate({ from: renaming, to });
  }, [renaming, renameDraft, rename, toast]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTopbar>
        <Kicker>shell</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Terminal
        </span>
        <Count>{sessions.length}</Count>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500 hidden md:inline">
          persistent tmux · attach from anywhere
        </span>
        <Spacer />
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() => setShowNew(true)}
        >
          <Plus className="h-3 w-3" />
          New session
        </Button>
      </PageTopbar>

      <div className="flex h-full min-h-0 flex-1">
        {/* Sidebar: tmux sessions */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-ink-900/10 bg-paper-100/60 dark:border-ink-50/10 dark:bg-ink-800/40">
          <div className="flex items-center justify-between border-b border-ink-900/10 px-3 py-2 dark:border-ink-50/10">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-500 dark:text-ink-400">
              Sessions
            </span>
            <span className="font-mono text-[10px] text-ink-500 dark:text-ink-400">
              {sessions.length}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {isLoading ? (
              <>
                <Skeleton className="h-9 w-full rounded" />
                <Skeleton className="h-9 w-full rounded" />
                <Skeleton className="h-9 w-full rounded" />
              </>
            ) : sessions.length === 0 ? (
              <div className="rounded border border-dashed border-ink-900/15 p-3 text-center text-[11px] text-ink-500 dark:border-ink-50/15 dark:text-ink-400">
                no tmux sessions
                <button
                  type="button"
                  className="mt-2 block w-full text-[10px] uppercase tracking-[0.12em] text-ember-700 hover:underline dark:text-ember-300"
                  onClick={() => setShowNew(true)}
                >
                  start one
                </button>
              </div>
            ) : (
              sessions.map((s) => {
                const isActive = s.name === sessionName;
                const isRenaming = renaming === s.name;
                const lastSeen = s.activity ?? s.createdAt;
                return (
                  <div
                    key={s.name}
                    className={cn(
                      "group flex items-center gap-1.5 rounded border px-2 py-1.5 text-[12px] transition",
                      isActive
                        ? "border-ember-500/60 bg-ember-500/10 text-ink-900 dark:border-ember-400/50 dark:text-ink-50"
                        : "border-transparent hover:border-ink-900/15 hover:bg-paper-50 dark:hover:border-ink-50/15 dark:hover:bg-ink-800/70",
                    )}
                  >
                    {isRenaming ? (
                      <form
                        className="flex flex-1 min-w-0 items-center gap-1"
                        onSubmit={(e) => {
                          e.preventDefault();
                          submitRename();
                        }}
                      >
                        <Input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.preventDefault();
                              setRenaming(null);
                            }
                          }}
                          className="h-6 px-1.5 font-mono text-[11px]"
                        />
                        <button
                          type="submit"
                          className="shrink-0 rounded p-0.5 text-ember-700 hover:bg-ember-500/10 dark:text-ember-300"
                          title="Save"
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          className="shrink-0 rounded p-0.5 text-ink-500 hover:bg-ink-900/5 dark:hover:bg-ink-50/10"
                          onClick={() => setRenaming(null)}
                          title="Cancel"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="flex-1 min-w-0 text-left"
                          onClick={() =>
                            navigate(`/terminal/${encodeURIComponent(s.name)}`)
                          }
                        >
                          <div className="flex items-center gap-1.5">
                            <TerminalIcon
                              className={cn(
                                "h-3 w-3 shrink-0",
                                isActive
                                  ? "text-ember-700 dark:text-ember-300"
                                  : "text-ink-400",
                              )}
                            />
                            <span className="truncate font-mono">{s.name}</span>
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
                            <span>
                              {s.windows} {s.windows === 1 ? "win" : "wins"}
                            </span>
                            {s.attached && (
                              <span className="flex items-center gap-1 text-ember-700 dark:text-ember-300">
                                <Users className="h-2.5 w-2.5" />
                                live
                              </span>
                            )}
                            <span
                              className="ml-auto truncate"
                              title={new Date(lastSeen).toLocaleString()}
                            >
                              {formatTs(lastSeen)}
                            </span>
                          </div>
                        </button>
                        <button
                          type="button"
                          className="shrink-0 rounded p-1 text-ink-400 opacity-0 transition hover:bg-ink-900/5 hover:text-ink-700 group-hover:opacity-100 dark:hover:bg-ink-50/10 dark:hover:text-ink-200"
                          onClick={(e) => {
                            e.stopPropagation();
                            beginRename(s.name);
                          }}
                          title="Rename session"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          className="shrink-0 rounded p-1 text-ink-400 opacity-0 transition hover:bg-ink-900/5 hover:text-red-700 group-hover:opacity-100 dark:hover:bg-ink-50/10 dark:hover:text-red-300"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (
                              window.confirm(
                                `Kill tmux session "${s.name}"? Any work inside will be terminated.`,
                              )
                            ) {
                              kill.mutate(s.name);
                            }
                          }}
                          title="Kill session"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t border-ink-900/10 p-2 dark:border-ink-50/10">
            <button
              type="button"
              onClick={() => setShowNew(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-ink-900/20 py-1.5 text-[11px] text-ink-600 transition hover:border-ember-500/60 hover:text-ember-700 dark:border-ink-50/20 dark:text-ink-300 dark:hover:border-ember-400/60 dark:hover:text-ember-300"
            >
              <Plus className="h-3 w-3" />
              new
            </button>
          </div>
        </aside>

        {/* Pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          {active && (
            <div className="flex h-7 items-center justify-between border-b border-ink-900/10 bg-paper-100/40 px-3 dark:border-ink-50/10 dark:bg-ink-800/30">
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-600 dark:text-ink-300">
                <span>tmux</span>
                <span className="text-ink-400">·</span>
                <span className="text-ink-900 dark:text-ink-50">
                  {active.name}
                </span>
                {active.attached && (
                  <span className="flex items-center gap-1 text-ember-700 dark:text-ember-300">
                    <Users className="h-2.5 w-2.5" />
                    {/* Could be us — tmux can't tell us apart from other clients */}
                    shared
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onCopyAttachCmd}
                  title="Copy attach command (paste into a real terminal)"
                  className="rounded p-1 text-ink-500 transition hover:bg-ink-900/5 hover:text-ink-900 dark:hover:bg-ink-50/10 dark:hover:text-ink-50"
                >
                  <Copy className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => navigate("/terminal")}
                  title="Detach"
                  className="rounded p-1 text-ink-500 transition hover:bg-ink-900/5 hover:text-ink-900 dark:hover:bg-ink-50/10 dark:hover:text-ink-50"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}
          {active && <WindowStrip sessionName={active.name} />}
          <div className="min-h-0 flex-1">
            <XTermPane
              connect={connect}
              connectionKey={sessionName ?? ""}
              emptyHint={
                sessions.length === 0
                  ? "press “new session” to start a tmux"
                  : "select a session"
              }
              onError={(m) => toast(m, true)}
            />
          </div>
        </div>
      </div>

      <NewSessionDialog
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreate={(name, cwd) => create.mutate({ name, ...(cwd ? { cwd } : {}) })}
        busy={create.isPending}
        existing={sessions.map((s) => s.name)}
      />
    </div>
  );
}

/**
 * Window tab strip. Lists tmux windows in the active session, lets the user
 * switch between them (changes which window the embedded pane shows on next
 * tmux redraw), create / kill / rename windows. tmux itself is the source of
 * truth — we just poll.
 */
function WindowStrip({ sessionName }: { sessionName: string }) {
  const client = useClient();
  const { toast } = useApp();
  const qc = useQueryClient();
  const [renamingIdx, setRenamingIdx] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Windows list is pushed via the WS bus too — long fallback only.
  const { data } = useQuery({
    queryKey: windowsKey(sessionName),
    queryFn: () => client.listTerminalWindows(sessionName),
    refetchInterval: 30_000,
    staleTime: 30_000,
  });
  const windows = data?.windows ?? [];

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: windowsKey(sessionName) });
  }, [qc, sessionName]);

  const create = useMutation({
    mutationFn: () => client.createTerminalWindow(sessionName, {}),
    onSuccess: invalidate,
    onError: (e) => toast(`new window: ${(e as Error).message}`, true),
  });

  const select = useMutation({
    mutationFn: (index: number) => client.selectTerminalWindow(sessionName, index),
    onSuccess: invalidate,
    onError: (e) => toast(`select: ${(e as Error).message}`, true),
  });

  const renameW = useMutation({
    mutationFn: ({ index, name }: { index: number; name: string }) =>
      client.renameTerminalWindow(sessionName, index, { name }),
    onSuccess: () => {
      setRenamingIdx(null);
      invalidate();
    },
    onError: (e) => toast(`rename: ${(e as Error).message}`, true),
  });

  const killW = useMutation({
    mutationFn: (index: number) => client.killTerminalWindow(sessionName, index),
    onSuccess: (res) => {
      invalidate();
      if (!res.sessionAlive) {
        void qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      }
    },
    onError: (e) => toast(`kill: ${(e as Error).message}`, true),
  });

  // Reset rename draft when switching sessions.
  useEffect(() => {
    setRenamingIdx(null);
  }, [sessionName]);

  return (
    <div className="flex h-7 items-center gap-1 overflow-x-auto border-b border-ink-900/10 bg-paper-50 px-2 dark:border-ink-50/10 dark:bg-ink-900/30">
      {windows.length === 0 ? (
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
          loading windows…
        </span>
      ) : (
        windows.map((w) => {
          const editing = renamingIdx === w.index;
          return (
            <div
              key={w.index}
              className={cn(
                "group flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-[11px] transition",
                w.active
                  ? "border-ember-500/50 bg-ember-500/10 text-ink-900 dark:border-ember-400/50 dark:text-ink-50"
                  : "border-ink-900/10 bg-paper-100 text-ink-600 hover:border-ink-900/20 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800/50 dark:text-ink-300 dark:hover:text-ink-50",
              )}
            >
              {editing ? (
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = renameDraft.trim();
                    if (!next || next === w.name) {
                      setRenamingIdx(null);
                      return;
                    }
                    renameW.mutate({ index: w.index, name: next });
                  }}
                >
                  <span className="font-mono text-[10px] tabular-nums opacity-60">
                    {w.index}
                  </span>
                  <Input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingIdx(null);
                      }
                    }}
                    className="h-4 w-24 px-1 font-mono text-[10px]"
                  />
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      if (!w.active) select.mutate(w.index);
                    }}
                    onDoubleClick={() => {
                      setRenamingIdx(w.index);
                      setRenameDraft(w.name);
                    }}
                    title={`window ${w.index}${w.panes > 1 ? ` · ${w.panes} panes` : ""}${w.activity ? ` · last ${formatTs(w.activity)}` : ""} (double-click to rename)`}
                    className="flex items-center gap-1"
                  >
                    <span className="font-mono text-[10px] tabular-nums opacity-60">
                      {w.index}
                    </span>
                    <span className="font-mono">{w.name || "shell"}</span>
                    {w.panes > 1 && (
                      <span className="font-mono text-[9px] opacity-60">
                        ·{w.panes}
                      </span>
                    )}
                  </button>
                  {windows.length > 1 && (
                    <button
                      type="button"
                      className="rounded p-0.5 text-ink-400 opacity-0 transition hover:bg-ink-900/5 hover:text-red-700 group-hover:opacity-100 dark:hover:bg-ink-50/10 dark:hover:text-red-300"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          window.confirm(
                            `Kill window ${w.index} (${w.name || "shell"})?`,
                          )
                        ) {
                          killW.mutate(w.index);
                        }
                      }}
                      title="Kill window"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })
      )}
      <button
        type="button"
        onClick={() => create.mutate()}
        disabled={create.isPending}
        className="ml-auto flex h-5 shrink-0 items-center gap-1 rounded border border-dashed border-ink-900/20 px-1.5 font-mono text-[10px] text-ink-500 transition hover:border-ember-500/60 hover:text-ember-700 disabled:opacity-50 dark:border-ink-50/20 dark:text-ink-400 dark:hover:border-ember-400/60 dark:hover:text-ember-300"
        title="New window"
      >
        <Plus className="h-2.5 w-2.5" />
        win
      </button>
    </div>
  );
}

function NewSessionDialog({
  open,
  onClose,
  onCreate,
  busy,
  existing,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, cwd?: string) => void;
  busy: boolean;
  existing: string[];
}) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const trimmed = name.trim();
  const trimmedCwd = cwd.trim();
  const taken = existing.includes(trimmed);
  const valid = NAME_RE.test(trimmed);
  const suggested = useMemo(() => {
    const base = "dev";
    let i = 1;
    while (existing.includes(i === 1 ? base : `${base}-${i}`)) i += 1;
    return i === 1 ? base : `${base}-${i}`;
  }, [existing]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setName("");
          setCwd("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TerminalIcon className="h-4 w-4 text-ember-600 dark:text-ember-400" />
            New tmux session
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
              Name
            </label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={suggested}
              className="font-mono text-sm"
            />
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-ink-400">
              persistent — survives daemon restarts of the tmux server,
              browser tabs can share it.
            </p>
            {taken && (
              <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">
                a session with that name already exists
              </p>
            )}
            {!valid && trimmed.length > 0 && (
              <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">
                use letters, digits, _, ., -, :, space (max 64 chars)
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-500 dark:text-ink-400">
              Working directory <span className="opacity-60">(optional)</span>
            </label>
            <Input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/repo  (defaults to $HOME)"
              className="font-mono text-sm"
            />
            <p className="mt-1.5 text-[11px] text-ink-500 dark:text-ink-400">
              starts the shell here. ignored if the path doesn't exist on the
              daemon.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setName("");
              setCwd("");
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || !valid || taken}
            onClick={() => {
              const finalName = trimmed || suggested;
              onCreate(finalName, trimmedCwd || undefined);
            }}
          >
            {busy ? "Starting…" : "Start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
