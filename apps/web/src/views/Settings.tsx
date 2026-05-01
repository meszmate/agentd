import { useEffect, useId, useRef, useState } from "react";
import { Bell, BellOff, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Count,
  Kicker,
  PageTopbar,
  Spacer,
  VRule,
} from "@/components/ui/page-topbar";
import { SectionHeader } from "@/components/ui/section-header";
import { InfoRow, ToggleRow } from "@/components/ui/info-row";
import { usePatchSettings, useSettings } from "@/queries";
import { useApp } from "@/AppContext";
import {
  getNotifPref,
  requestNotifPermission,
  setNotifPref,
} from "@/useNotifications";
import { cn } from "@/lib/utils";

interface RailItem {
  id: string;
  glyph: string;
  label: string;
}

const SECTIONS: RailItem[] = [
  { id: "agent", glyph: "§", label: "Agent policy" },
  { id: "thinking", glyph: "✦", label: "Thinking defaults" },
  { id: "ai-helpers", glyph: "✶", label: "AI helpers" },
  { id: "commits", glyph: "◆", label: "Commits & PRs" },
  { id: "browser", glyph: "▢", label: "Browser" },
];

type ThinkingLevel = "low" | "medium" | "high" | "max" | "xhigh";

const THINKING_LEVELS: {
  value: ThinkingLevel;
  label: string;
  hint: string;
}[] = [
  { value: "low", label: "low", hint: "fastest, minimal reasoning" },
  { value: "medium", label: "medium", hint: "balanced" },
  { value: "high", label: "high", hint: "solid for multi-step engineering" },
  { value: "max", label: "max", hint: "Claude's deepest tier" },
  { value: "xhigh", label: "xhigh", hint: "Claude default · Codex's deepest tier" },
];

export function Settings() {
  const { toast } = useApp();
  const settingsQ = useSettings();
  const patch = usePatchSettings();

  const [agentInstructions, setAgentInstructions] = useState("");
  const [commitPrefix, setCommitPrefix] = useState("");
  const [prTitlePrefix, setPrTitlePrefix] = useState("");
  const [prBodyTemplate, setPrBodyTemplate] = useState("");
  const [maxContextTokens, setMaxContextTokens] = useState<number>(8000);
  const [helperBinary, setHelperBinary] = useState("claude");
  const [helperModel, setHelperModel] = useState("");
  const [helperEffort, setHelperEffort] = useState<ThinkingLevel>("medium");
  const [defaultClaude, setDefaultClaude] = useState<ThinkingLevel>("xhigh");
  const [defaultCodex, setDefaultCodex] = useState<ThinkingLevel>("high");
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [active, setActive] = useState<string>("agent");
  const [savedFlash, setSavedFlash] = useState(false);

  const aiId = useId();
  const cpId = useId();
  const prtId = useId();
  const prbId = useId();
  const ctxId = useId();

  useEffect(() => {
    if (!settingsQ.data || hydrated) return;
    setAgentInstructions(settingsQ.data.agentInstructions);
    setCommitPrefix(settingsQ.data.commitPrefix);
    setPrTitlePrefix(settingsQ.data.prTitlePrefix);
    setPrBodyTemplate(settingsQ.data.prBodyTemplate);
    setMaxContextTokens(settingsQ.data.maxContextTokens ?? 8000);
    setHelperBinary(settingsQ.data.aiHelpers?.binary ?? "claude");
    setHelperModel(settingsQ.data.aiHelpers?.model ?? "");
    setHelperEffort(
      (settingsQ.data.aiHelpers?.effort as ThinkingLevel) ?? "medium",
    );
    setDefaultClaude(
      (settingsQ.data.defaultThinking?.claude as ThinkingLevel) ?? "xhigh",
    );
    setDefaultCodex(
      (settingsQ.data.defaultThinking?.codex as ThinkingLevel) ?? "high",
    );
    setHydrated(true);
  }, [settingsQ.data, hydrated]);

  useEffect(() => {
    if (!hydrated || !settingsQ.data) return;
    const d = settingsQ.data;
    const isDirty =
      agentInstructions !== d.agentInstructions ||
      commitPrefix !== d.commitPrefix ||
      prTitlePrefix !== d.prTitlePrefix ||
      prBodyTemplate !== d.prBodyTemplate ||
      maxContextTokens !== (d.maxContextTokens ?? 8000) ||
      helperBinary !== (d.aiHelpers?.binary ?? "claude") ||
      helperModel !== (d.aiHelpers?.model ?? "") ||
      helperEffort !== (d.aiHelpers?.effort ?? "medium") ||
      defaultClaude !== (d.defaultThinking?.claude ?? "xhigh") ||
      defaultCodex !== (d.defaultThinking?.codex ?? "high");
    setDirty(isDirty);
  }, [
    agentInstructions,
    commitPrefix,
    prTitlePrefix,
    prBodyTemplate,
    maxContextTokens,
    helperBinary,
    helperModel,
    helperEffort,
    defaultClaude,
    defaultCodex,
    hydrated,
    settingsQ.data,
  ]);

  const saveRef = useRef<() => void>();
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && dirty) {
        e.preventDefault();
        saveRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty]);

  // Scroll-spy for rail
  useEffect(() => {
    const ids = SECTIONS.map((s) => s.id);
    const onScroll = () => {
      let cur = ids[0]!;
      for (const id of ids) {
        const el = document.getElementById(`section-${id}`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= 80) cur = id;
      }
      setActive(cur);
    };
    const main = document.getElementById("settings-scroll");
    main?.addEventListener("scroll", onScroll, { passive: true });
    return () => main?.removeEventListener("scroll", onScroll);
  }, []);

  async function save() {
    try {
      await patch.mutateAsync({
        agentInstructions,
        commitPrefix,
        prTitlePrefix,
        prBodyTemplate,
        maxContextTokens,
        aiHelpers: {
          binary: helperBinary.trim(),
          model: helperModel.trim(),
          effort: helperEffort,
        },
        defaultThinking: {
          claude: defaultClaude,
          codex: defaultCodex,
        },
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 2000);
      toast("Settings saved");
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  if (!hydrated) {
    return <SettingsSkeleton />;
  }

  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>account</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Settings
        </span>
        <Count>server-side · applies to next agent run</Count>
        <Spacer />
        {dirty && (
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ember-700 dark:text-ember-300">
            unsaved
          </span>
        )}
        {savedFlash && (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-emerald-700 dark:text-emerald-300">
            <span className="size-1.5 rounded-full bg-emerald-500" /> saved
          </span>
        )}
      </PageTopbar>

      {/* Body: rail + content */}
      <div className="flex flex-1 min-h-0">
        <aside className="hidden md:flex w-52 shrink-0 flex-col bg-paper-50 dark:bg-ink-900 border-r border-ink-900/10 dark:border-ink-50/10">
          <div className="flex h-9 items-center justify-between px-4 border-b border-ink-900/[0.06] dark:border-ink-50/[0.06]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-400 dark:text-ink-500">
              Sections
            </span>
            <span
              className={cn(
                "font-mono text-[10px]",
                dirty
                  ? "text-ember-700 dark:text-ember-300"
                  : "text-ink-300 dark:text-ink-600",
              )}
            >
              {dirty ? "•" : "ok"}
            </span>
          </div>
          <nav className="flex-1 py-1.5">
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#section-${s.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  setActive(s.id);
                  document
                    .getElementById(`section-${s.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={cn(
                  "h-8 pl-[14px] pr-4 flex items-center gap-2.5 text-[12px] transition-colors border-l-2",
                  active === s.id
                    ? "bg-paper-50 text-ink-900 border-ember-500 font-medium dark:bg-ink-50/[0.05] dark:text-ink-50"
                    : "text-ink-500 hover:bg-paper-50 hover:text-ink-900 border-transparent dark:text-ink-400 dark:hover:bg-ink-700",
                )}
              >
                <span
                  className={cn(
                    "font-mono text-[11px] w-3 shrink-0",
                    active === s.id
                      ? "text-ember-500"
                      : "text-ink-400 dark:text-ink-500",
                  )}
                >
                  {s.glyph}
                </span>
                <span>{s.label}</span>
              </a>
            ))}
          </nav>
        </aside>

        <div
          id="settings-scroll"
          className="flex-1 min-h-0 overflow-y-auto"
        >
          {/* Agent policy */}
          <div id="section-agent">
            <SectionHeader
              label="Agent policy"
              hint="appended via --append-system-prompt"
              sticky
            />
            <InfoRow
              label="System prompt suffix"
              hint="Appended to every run."
              top
            >
              <Textarea
                id={aiId}
                rows={6}
                value={agentInstructions}
                onChange={(e) => setAgentInstructions(e.target.value)}
                className="font-mono text-xs"
                placeholder="Suppress model self-references and attribution trailers in any output."
              />
            </InfoRow>
            <InfoRow
              label="Context budget"
              hint={
                <>
                  Token soft-cap for the system-prompt suffix (skills + this
                  policy + repo CLAUDE.md). Lower-priority skills get
                  auto-trimmed when the total exceeds this.
                </>
              }
            >
              <div className="flex items-center gap-2">
                <Input
                  id={ctxId}
                  type="number"
                  min={500}
                  step={500}
                  value={maxContextTokens}
                  onChange={(e) =>
                    setMaxContextTokens(
                      Math.max(500, Number(e.target.value) || 0),
                    )
                  }
                  className="font-mono w-32"
                />
                <span className="font-mono text-[10px] text-ink-500 dark:text-ink-400">
                  tokens · default 8000
                </span>
              </div>
            </InfoRow>
          </div>

          {/* Thinking defaults */}
          <div id="section-thinking">
            <SectionHeader
              label="Thinking defaults"
              hint="reasoning effort applied when a task is spawned without one"
              sticky
            />
            <InfoRow
              label="Claude default"
              hint={
                <>
                  Claude's own default is{" "}
                  <code className="font-mono text-[10px] text-ink-700 dark:text-ink-200">
                    xhigh
                  </code>
                  . The deepest tier is{" "}
                  <code className="font-mono text-[10px] text-ink-700 dark:text-ink-200">
                    max
                  </code>
                  .
                </>
              }
              top
            >
              <ThinkingPicker value={defaultClaude} onChange={setDefaultClaude} />
            </InfoRow>
            <InfoRow
              label="Codex default"
              hint={
                <>
                  Codex's practical default is{" "}
                  <code className="font-mono text-[10px] text-ink-700 dark:text-ink-200">
                    high
                  </code>
                  . The deepest Codex tier is{" "}
                  <code className="font-mono text-[10px] text-ink-700 dark:text-ink-200">
                    xhigh
                  </code>
                  .
                </>
              }
            >
              <ThinkingPicker value={defaultCodex} onChange={setDefaultCodex} />
            </InfoRow>
          </div>

          {/* AI helpers */}
          <div id="section-ai-helpers">
            <SectionHeader
              label="AI helpers"
              hint="model + effort for commit messages, PR bodies, branch names"
              sticky
            />
            <InfoRow
              label="Binary"
              hint={
                <>
                  CLI to invoke for helper calls. Defaults to{" "}
                  <code className="font-mono text-[10px] text-ink-700 dark:text-ink-200">
                    claude
                  </code>{" "}
                  on $PATH.
                </>
              }
              top
            >
              <Input
                value={helperBinary}
                onChange={(e) => setHelperBinary(e.target.value)}
                placeholder="claude"
                className="font-mono w-56"
              />
            </InfoRow>
            <InfoRow
              label="Model"
              hint={
                <>
                  Optional <code className="font-mono">--model</code> override.
                  Leave blank to inherit Claude's default.
                </>
              }
            >
              <Input
                value={helperModel}
                onChange={(e) => setHelperModel(e.target.value)}
                placeholder="(inherit) e.g. claude-haiku-4-5"
                className="font-mono w-72"
              />
            </InfoRow>
            <InfoRow
              label="Effort"
              hint="higher → better wording, slower & more expensive"
            >
              <ThinkingPicker value={helperEffort} onChange={setHelperEffort} />
            </InfoRow>
          </div>

          {/* Commits & PRs */}
          <div id="section-commits">
            <SectionHeader
              label="Commits & PRs"
              hint="auto-commit messages and gh pr create body"
              sticky
            />
            <InfoRow
              label="Commit prefix"
              hint="prepended to every auto-commit"
            >
              <Input
                id={cpId}
                value={commitPrefix}
                onChange={(e) => setCommitPrefix(e.target.value)}
                placeholder="agentd: "
                className="font-mono"
              />
            </InfoRow>
            <InfoRow
              label="PR title prefix"
              hint="prepended to gh pr create"
            >
              <Input
                id={prtId}
                value={prTitlePrefix}
                onChange={(e) => setPrTitlePrefix(e.target.value)}
                placeholder="agentd: "
                className="font-mono"
              />
            </InfoRow>
            <InfoRow
              label="PR body template"
              hint={
                <>
                  Placeholders:{" "}
                  {["{prompt}", "{title}", "{task_id}", "{branch}"].map(
                    (p) => (
                      <code
                        key={p}
                        className="font-mono text-[10px] text-ink-700 dark:text-ink-200"
                      >
                        {p}{" "}
                      </code>
                    ),
                  )}
                </>
              }
              top
            >
              <Textarea
                id={prbId}
                rows={6}
                value={prBodyTemplate}
                onChange={(e) => setPrBodyTemplate(e.target.value)}
                className="font-mono text-xs"
              />
            </InfoRow>
          </div>

          {/* Browser */}
          <div id="section-browser">
            <SectionHeader
              label="Browser"
              hint="local-only, this device"
              sticky
            />
            <NotificationsRow />
          </div>

          {/* Spacer to allow last section to scroll into view */}
          <div className="h-24" />
        </div>
      </div>

      {/* Sticky save bar */}
      <div className="flex h-9 items-center gap-3 px-5 border-t border-ink-900/10 bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 shrink-0">
        <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
          config.json
        </span>
        <span className="text-ink-300 dark:text-ink-600">·</span>
        <span className="text-[10px] text-ink-400 dark:text-ink-500 truncate">
          applies to next agent run
        </span>
        <Spacer />
        <span className="hidden sm:flex items-center gap-1 font-mono text-[10px] text-ink-400 dark:text-ink-500">
          ⌘ S
        </span>
        <Button
          size="xs"
          onClick={save}
          disabled={patch.isPending || !dirty}
        >
          {patch.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Save className="h-3 w-3" />
          )}
          Save
        </Button>
      </div>
    </div>
  );
}

function NotificationsRow() {
  const { toast } = useApp();
  const [notifs, setNotifs] = useState<"ask" | "on" | "off">(() =>
    getNotifPref(),
  );
  const enabled = notifs === "on";

  async function toggle(checked: boolean) {
    if (!checked) {
      setNotifPref("off");
      setNotifs("off");
      toast("Notifications disabled");
      return;
    }
    const ok = await requestNotifPermission();
    setNotifs(ok ? "on" : "off");
    toast(ok ? "Notifications enabled" : "Permission denied", !ok);
  }

  return (
    <ToggleRow
      label="Desktop notifications"
      hint={
        enabled
          ? "Pings on done · failed · stopped (when tab is hidden)."
          : "Disabled — agentd won't show OS notifications."
      }
      value={enabled}
      onChange={(v) => void toggle(v)}
    />
  );
}

function ThinkingPicker({
  value,
  onChange,
}: {
  value: ThinkingLevel;
  onChange: (next: ThinkingLevel) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {THINKING_LEVELS.map((m) => {
        const on = value === m.value;
        return (
          <button
            key={m.value}
            type="button"
            onClick={() => onChange(m.value)}
            title={m.hint}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] transition-colors",
              on
                ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
            )}
          >
            <span className="font-mono">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <PageTopbar>
        <Kicker>account</Kicker>
        <VRule />
        <span className="text-[13px] text-ink-900 dark:text-ink-50 font-medium">
          Settings
        </span>
      </PageTopbar>
      <div className="flex flex-1 min-h-0">
        <aside className="hidden md:flex w-52 shrink-0 flex-col bg-paper-50 dark:bg-ink-800 border-r border-ink-900/10 dark:border-ink-50/10 px-2 py-2 gap-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </aside>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-6 max-w-3xl space-y-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

void Bell;
void BellOff;
