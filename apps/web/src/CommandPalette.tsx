import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "./queries";
import { useApp } from "./AppContext";
import { MOD } from "./useKeyboard";
import type { Task, Template, Schedule } from "@agentd/contracts";

interface Command {
  id: string;
  label: string;
  group: "navigate" | "task" | "template" | "schedule" | "action";
  glyph: string;
  sub?: string;
  hint?: string;
  run: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Universal launcher: searches navigation, recent tasks, templates,
 * schedules, plus a few quick actions. Opens with ⌘K, navigates with arrow
 * keys, fires with Enter, dismisses with Escape. Source data comes from the
 * Query cache so the palette is instant — no extra fetch on open.
 */
export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { logout } = useApp();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Read from cache directly instead of triggering new requests when the
  // palette opens — keeps it snappy.
  const tasks = (qc.getQueryData(qk.tasks()) as { tasks: Task[] } | undefined)?.tasks ?? [];
  const templates =
    (qc.getQueryData(qk.templates()) as { templates: Template[] } | undefined)?.templates ?? [];
  const schedules =
    (qc.getQueryData(qk.schedules()) as { schedules: Schedule[] } | undefined)?.schedules ?? [];

  const all: Command[] = useMemo(() => {
    const cmds: Command[] = [
      { id: "nav-tasks", group: "navigate", glyph: "›", label: "Go to Tasks", hint: "g t", run: () => navigate("/tasks") },
      { id: "nav-templates", group: "navigate", glyph: "›", label: "Go to Templates", hint: "g e", run: () => navigate("/templates") },
      { id: "nav-schedules", group: "navigate", glyph: "›", label: "Go to Schedules", hint: "g s", run: () => navigate("/schedules") },
      { id: "nav-plugins", group: "navigate", glyph: "›", label: "Go to Plugins", hint: "g p", run: () => navigate("/plugins") },
      { id: "nav-settings", group: "navigate", glyph: "›", label: "Go to Settings", hint: "g , ", run: () => navigate("/settings") },
      { id: "act-spawn", group: "action", glyph: "+", label: "Spawn new task", hint: "/", run: () => navigate("/tasks") },
      { id: "act-tpl", group: "action", glyph: "+", label: "New template", run: () => navigate("/templates") },
      { id: "act-sched", group: "action", glyph: "+", label: "New schedule", run: () => navigate("/schedules") },
      { id: "act-logout", group: "action", glyph: "⎋", label: "Log out", run: () => logout() },
    ];
    for (const t of tasks) {
      cmds.push({
        id: "task-" + t.id,
        group: "task",
        glyph: "·",
        label: t.title,
        sub: `${t.id.slice(-8)} · ${t.status}`,
        run: () => navigate(`/tasks/${t.id}`),
      });
    }
    for (const t of templates) {
      cmds.push({
        id: "tpl-" + t.id,
        group: "template",
        glyph: "·",
        label: t.name,
        sub: `${t.agent} · ${t.repoPath}`,
        run: () => navigate("/templates"),
      });
    }
    for (const s of schedules) {
      cmds.push({
        id: "sch-" + s.id,
        group: "schedule",
        glyph: "·",
        label: s.name,
        sub: `${s.cron}${s.enabled ? "" : " · disabled"}`,
        run: () => navigate("/schedules"),
      });
    }
    return cmds;
  }, [tasks, templates, schedules, navigate, logout]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    // Word-boundary scoring: every query word must appear somewhere in the
    // label or subtitle. Keeps results predictable without a real fuzzy lib.
    const words = q.split(/\s+/);
    return all.filter((c) => {
      const hay = `${c.label} ${c.sub ?? ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [all, query]);

  // Group results by category for the rendered output, preserving the
  // filtered order within each group.
  const groups = useMemo(() => {
    const order: Command["group"][] = ["navigate", "action", "task", "template", "schedule"];
    const map = new Map<Command["group"], Command[]>();
    for (const c of filtered) {
      const list = map.get(c.group) ?? [];
      list.push(c);
      map.set(c.group, list);
    }
    return order
      .map((g) => ({ name: g, items: map.get(g) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Reset state every time we open.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      // focus the input after the modal mounts
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keep selected index in range when results shrink.
  useEffect(() => {
    if (selected >= flat.length) setSelected(Math.max(0, flat.length - 1));
  }, [selected, flat.length]);

  // Scroll the selected item into view as we navigate.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLButtonElement>(".cmdk__item.selected");
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [selected, open]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = flat[selected];
      if (cmd) {
        void cmd.run();
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  function groupLabel(g: Command["group"]): string {
    return (
      {
        navigate: "navigation",
        action: "actions",
        task: "tasks",
        template: "templates",
        schedule: "schedules",
      } as const
    )[g];
  }

  return (
    <div
      className="cmdk-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="cmdk__input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          placeholder="type a command, task, template…"
          aria-label="Search commands"
          spellCheck={false}
          autoComplete="off"
        />
        <div
          ref={listRef}
          className="cmdk__list"
          role="listbox"
          aria-label="Command results"
          tabIndex={-1}
        >
          {flat.length === 0 ? (
            <div className="cmdk__empty">no matches</div>
          ) : (
            groups.map((g) => (
              <div key={g.name}>
                <div className="cmdk__group-label">{groupLabel(g.name)}</div>
                {g.items.map((c) => {
                  const idx = flat.indexOf(c);
                  const isSel = idx === selected;
                  return (
                    <button
                      type="button"
                      key={c.id}
                      role="option"
                      aria-selected={isSel}
                      className={`cmdk__item${isSel ? " selected" : ""}`}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => {
                        void c.run();
                        onClose();
                      }}
                    >
                      <span className="glyph" aria-hidden="true">{c.glyph}</span>
                      <span className="label">
                        {c.label}
                        {c.sub && (
                          <>
                            {" "}
                            <span className="sub">{c.sub}</span>
                          </>
                        )}
                      </span>
                      {c.hint && (
                        <span className="sub" aria-hidden="true">
                          {c.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="cmdk__foot" aria-hidden="true">
          <span>
            <span className="kbd">↑↓</span> navigate
          </span>
          <span>
            <span className="kbd">↵</span> select
          </span>
          <span>
            <span className="kbd">esc</span> close
          </span>
          <span style={{ marginLeft: "auto" }}>
            <span className="kbd">{MOD}</span>
            <span className="kbd">K</span> to open
          </span>
        </div>
      </div>
    </div>
  );
}
