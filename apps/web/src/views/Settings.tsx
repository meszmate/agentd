import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bell, BellOff, BookText, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";

const SkillsView = lazy(() =>
  import("@/views/Skills").then((m) => ({ default: m.Skills })),
);
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
import {
  useModels,
  usePatchSettings,
  useSettings,
} from "@/queries";
import type { AgentdModelRegistry } from "@agentd/client";
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
  { id: "models", glyph: "△", label: "Models" },
  { id: "thinking", glyph: "✦", label: "Thinking defaults" },
  { id: "ai-helpers", glyph: "✶", label: "AI helpers" },
  { id: "commits", glyph: "◆", label: "Commits & PRs" },
  { id: "grid", glyph: "⌗", label: "Grid" },
  { id: "review", glyph: "⌖", label: "Adversarial review" },
  { id: "browser", glyph: "▢", label: "Browser" },
];

const REVIEW_DEFAULTS = {
  enabled: false,
  agent: "claude" as const,
  model: "",
  thinkingLevel: "high" as ThinkingLevel,
  blockOnFail: true,
  maxDiffBytes: 200_000,
  timeoutMs: 5 * 60_000,
};

type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const THINKING_LEVEL_META: Record<
  ThinkingLevel,
  { label: string; hint: string }
> = {
  minimal: { label: "minimal", hint: "codex-only — lightest reasoning" },
  low: { label: "low", hint: "fastest, minimal reasoning" },
  medium: { label: "medium", hint: "balanced" },
  high: { label: "high", hint: "solid for multi-step engineering" },
  xhigh: { label: "xhigh", hint: "Claude default · Codex's deepest tier" },
  max: { label: "max", hint: "claude-only — deepest tier" },
};

const THINKING_LEVELS_BY_AGENT: Record<
  "claude" | "codex",
  ReadonlyArray<ThinkingLevel>
> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

export function Settings() {
  const { toast } = useApp();
  const settingsQ = useSettings();
  const patch = usePatchSettings();
  const modelsQ = useModels();
  const location = useLocation();
  const onSkillsTab = location.pathname.startsWith("/settings/skills");

  const [agentInstructions, setAgentInstructions] = useState("");
  const [commitInstructions, setCommitInstructions] = useState("");
  const [prInstructions, setPrInstructions] = useState("");
  const [maxContextTokens, setMaxContextTokens] = useState<number>(8000);
  const [helperBinary, setHelperBinary] = useState("claude");
  const [helperModel, setHelperModel] = useState("");
  const [helperEffort, setHelperEffort] = useState<ThinkingLevel>("medium");
  // Per-feature overrides. Empty string in the model field === "inherit
  // the shared default above". A blank `effort` (null) means inherit
  // too. The Settings save trims empty values back to undefined so
  // older configs don't gain noise they didn't ask for.
  const [helperCommitModel, setHelperCommitModel] = useState("");
  const [helperCommitEffort, setHelperCommitEffort] =
    useState<ThinkingLevel | "">("");
  const [helperPrModel, setHelperPrModel] = useState("");
  const [helperPrEffort, setHelperPrEffort] = useState<ThinkingLevel | "">("");
  const [defaultClaude, setDefaultClaude] = useState<ThinkingLevel>("xhigh");
  const [defaultCodex, setDefaultCodex] = useState<ThinkingLevel>("high");
  const [defaultClaudeModel, setDefaultClaudeModel] = useState("");
  const [defaultCodexModel, setDefaultCodexModel] = useState("");
  // Default value of the spawn form's "drive" picker. The setting lives
  // on cfg (not prefs) so it's the authoritative default — operators
  // who live in terminal mode flip this once and every spawn surface
  // (main sheet, project tab, anywhere else that grows one) picks it
  // up. Per-task overrides on the spawn form still win.
  const [defaultTaskMode, setDefaultTaskMode] =
    useState<"managed" | "terminal">("terminal");
  const [reviewEnabled, setReviewEnabled] = useState(
    REVIEW_DEFAULTS.enabled,
  );
  const [reviewBlockOnFail, setReviewBlockOnFail] = useState(
    REVIEW_DEFAULTS.blockOnFail,
  );
  const [reviewAgent, setReviewAgent] = useState<"claude" | "codex">(
    REVIEW_DEFAULTS.agent,
  );
  const [reviewModel, setReviewModel] = useState(REVIEW_DEFAULTS.model);
  const [reviewThinking, setReviewThinking] = useState<ThinkingLevel>(
    REVIEW_DEFAULTS.thinkingLevel,
  );
  const [reviewMaxDiffBytes, setReviewMaxDiffBytes] = useState<number>(
    REVIEW_DEFAULTS.maxDiffBytes,
  );
  const [reviewTimeoutMs, setReviewTimeoutMs] = useState<number>(
    REVIEW_DEFAULTS.timeoutMs,
  );
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [active, setActive] = useState<string>("agent");
  const [savedFlash, setSavedFlash] = useState(false);

  const aiId = useId();
  const cpId = useId();
  const prtId = useId();
  const ctxId = useId();

  useEffect(() => {
    if (!settingsQ.data || hydrated) return;
    setAgentInstructions(settingsQ.data.agentInstructions);
    setCommitInstructions(settingsQ.data.commitInstructions ?? "");
    setPrInstructions(settingsQ.data.prInstructions ?? "");
    setMaxContextTokens(settingsQ.data.maxContextTokens ?? 8000);
    setHelperBinary(settingsQ.data.aiHelpers?.binary ?? "claude");
    setHelperModel(settingsQ.data.aiHelpers?.model ?? "");
    setHelperEffort(
      (settingsQ.data.aiHelpers?.effort as ThinkingLevel) ?? "medium",
    );
    setHelperCommitModel(settingsQ.data.aiHelpers?.commit?.model ?? "");
    setHelperCommitEffort(
      (settingsQ.data.aiHelpers?.commit?.effort as ThinkingLevel | undefined) ?? "",
    );
    setHelperPrModel(settingsQ.data.aiHelpers?.pr?.model ?? "");
    setHelperPrEffort(
      (settingsQ.data.aiHelpers?.pr?.effort as ThinkingLevel | undefined) ?? "",
    );
    setDefaultClaude(
      (settingsQ.data.defaultThinking?.claude as ThinkingLevel) ?? "xhigh",
    );
    setDefaultCodex(
      (settingsQ.data.defaultThinking?.codex as ThinkingLevel) ?? "high",
    );
    setDefaultClaudeModel(settingsQ.data.defaultModel?.claude ?? "");
    setDefaultCodexModel(settingsQ.data.defaultModel?.codex ?? "");
    setDefaultTaskMode(
      settingsQ.data.defaultTaskMode === "terminal" ? "terminal" : "managed",
    );
    const rv = settingsQ.data.review;
    if (rv) {
      setReviewEnabled(rv.enabled ?? REVIEW_DEFAULTS.enabled);
      setReviewBlockOnFail(rv.blockOnFail ?? REVIEW_DEFAULTS.blockOnFail);
      setReviewAgent((rv.agent as "claude" | "codex") ?? REVIEW_DEFAULTS.agent);
      setReviewModel(rv.model ?? REVIEW_DEFAULTS.model);
      setReviewThinking(
        (rv.thinkingLevel as ThinkingLevel) ?? REVIEW_DEFAULTS.thinkingLevel,
      );
      setReviewMaxDiffBytes(rv.maxDiffBytes ?? REVIEW_DEFAULTS.maxDiffBytes);
      setReviewTimeoutMs(rv.timeoutMs ?? REVIEW_DEFAULTS.timeoutMs);
    }
    setHydrated(true);
  }, [settingsQ.data, hydrated]);

  useEffect(() => {
    if (!hydrated || !settingsQ.data) return;
    const d = settingsQ.data;
    const isDirty =
      agentInstructions !== d.agentInstructions ||
      commitInstructions !== (d.commitInstructions ?? "") ||
      prInstructions !== (d.prInstructions ?? "") ||
      maxContextTokens !== (d.maxContextTokens ?? 8000) ||
      helperBinary !== (d.aiHelpers?.binary ?? "claude") ||
      helperModel !== (d.aiHelpers?.model ?? "") ||
      helperEffort !== (d.aiHelpers?.effort ?? "medium") ||
      helperCommitModel !== (d.aiHelpers?.commit?.model ?? "") ||
      helperCommitEffort !== ((d.aiHelpers?.commit?.effort as ThinkingLevel | undefined) ?? "") ||
      helperPrModel !== (d.aiHelpers?.pr?.model ?? "") ||
      helperPrEffort !== ((d.aiHelpers?.pr?.effort as ThinkingLevel | undefined) ?? "") ||
      defaultClaude !== (d.defaultThinking?.claude ?? "xhigh") ||
      defaultCodex !== (d.defaultThinking?.codex ?? "high") ||
      defaultClaudeModel !== (d.defaultModel?.claude ?? "") ||
      defaultCodexModel !== (d.defaultModel?.codex ?? "") ||
      defaultTaskMode !==
        (d.defaultTaskMode === "terminal" ? "terminal" : "managed") ||
      reviewEnabled !== (d.review?.enabled ?? REVIEW_DEFAULTS.enabled) ||
      reviewBlockOnFail !==
        (d.review?.blockOnFail ?? REVIEW_DEFAULTS.blockOnFail) ||
      reviewAgent !== (d.review?.agent ?? REVIEW_DEFAULTS.agent) ||
      reviewModel !== (d.review?.model ?? REVIEW_DEFAULTS.model) ||
      reviewThinking !==
        (d.review?.thinkingLevel ?? REVIEW_DEFAULTS.thinkingLevel) ||
      reviewMaxDiffBytes !==
        (d.review?.maxDiffBytes ?? REVIEW_DEFAULTS.maxDiffBytes) ||
      reviewTimeoutMs !== (d.review?.timeoutMs ?? REVIEW_DEFAULTS.timeoutMs);
    setDirty(isDirty);
  }, [
    agentInstructions,
    commitInstructions,
    prInstructions,
    maxContextTokens,
    helperBinary,
    helperModel,
    helperEffort,
    helperCommitModel,
    helperCommitEffort,
    helperPrModel,
    helperPrEffort,
    defaultClaude,
    defaultCodex,
    defaultClaudeModel,
    defaultCodexModel,
    defaultTaskMode,
    reviewEnabled,
    reviewBlockOnFail,
    reviewAgent,
    reviewModel,
    reviewThinking,
    reviewMaxDiffBytes,
    reviewTimeoutMs,
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

  function buildOverride(
    model: string,
    effort: ThinkingLevel | "",
  ): { model?: string; effort?: ThinkingLevel } | undefined {
    const trimmed = model.trim();
    // Skip the override entirely when both fields are empty so config.json
    // doesn't grow `commit: {}` / `pr: {}` blobs for installs that never
    // touched these.
    if (!trimmed && !effort) return undefined;
    const ov: { model?: string; effort?: ThinkingLevel } = {};
    if (trimmed) ov.model = trimmed;
    if (effort) ov.effort = effort;
    return ov;
  }

  async function save() {
    try {
      const commitOv = buildOverride(helperCommitModel, helperCommitEffort);
      const prOv = buildOverride(helperPrModel, helperPrEffort);
      await patch.mutateAsync({
        agentInstructions,
        commitInstructions,
        prInstructions,
        maxContextTokens,
        aiHelpers: {
          binary: helperBinary.trim(),
          model: helperModel.trim(),
          effort: helperEffort,
          ...(commitOv ? { commit: commitOv } : {}),
          ...(prOv ? { pr: prOv } : {}),
        },
        defaultThinking: {
          claude: defaultClaude,
          codex: defaultCodex,
        },
        defaultModel: {
          claude: defaultClaudeModel.trim(),
          codex: defaultCodexModel.trim(),
        },
        defaultTaskMode,
        review: {
          enabled: reviewEnabled,
          agent: reviewAgent,
          model: reviewModel.trim(),
          thinkingLevel: reviewThinking,
          blockOnFail: reviewBlockOnFail,
          maxDiffBytes: reviewMaxDiffBytes,
          timeoutMs: reviewTimeoutMs,
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
            <Link
              to="/settings/skills"
              className={cn(
                "h-8 pl-[14px] pr-4 flex items-center gap-2.5 text-[12px] transition-colors border-l-2",
                onSkillsTab
                  ? "bg-paper-50 text-ink-900 border-ember-500 font-medium dark:bg-ink-50/[0.05] dark:text-ink-50"
                  : "text-ink-500 hover:bg-paper-50 hover:text-ink-900 border-transparent dark:text-ink-400 dark:hover:bg-ink-700 dark:hover:text-ink-50",
              )}
            >
              <BookText
                className={cn(
                  "h-3 w-3 shrink-0",
                  onSkillsTab
                    ? "text-ember-500"
                    : "text-ink-400 dark:text-ink-500",
                )}
              />
              <span>Skills</span>
            </Link>
            <div className="mx-3 my-1.5 h-px bg-ink-900/[0.06] dark:bg-ink-50/[0.06]" />
            {SECTIONS.map((s) => (
              <Link
                key={s.id}
                to={`/settings#section-${s.id}`}
                onClick={(e) => {
                  if (onSkillsTab) return;
                  e.preventDefault();
                  setActive(s.id);
                  document
                    .getElementById(`section-${s.id}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className={cn(
                  "h-8 pl-[14px] pr-4 flex items-center gap-2.5 text-[12px] transition-colors border-l-2",
                  !onSkillsTab && active === s.id
                    ? "bg-paper-50 text-ink-900 border-ember-500 font-medium dark:bg-ink-50/[0.05] dark:text-ink-50"
                    : "text-ink-500 hover:bg-paper-50 hover:text-ink-900 border-transparent dark:text-ink-400 dark:hover:bg-ink-700 dark:hover:text-ink-50",
                )}
              >
                <span
                  className={cn(
                    "font-mono text-[11px] w-3 shrink-0",
                    !onSkillsTab && active === s.id
                      ? "text-ember-500"
                      : "text-ink-400 dark:text-ink-500",
                  )}
                >
                  {s.glyph}
                </span>
                <span>{s.label}</span>
              </Link>
            ))}
          </nav>
        </aside>

        {onSkillsTab ? (
          <div className="flex-1 min-h-0 overflow-hidden">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-ink-500 dark:text-ink-400">
                  Loading…
                </div>
              }
            >
              <SkillsView embedded />
            </Suspense>
          </div>
        ) : (
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

          {/* Models — per-agent default. Per-task overrides live on the
              spawn UI and the task header. */}
          <div id="section-models">
            <SectionHeader
              label="Models"
              hint="default --model passed to each agent CLI"
              sticky
            />
            <InfoRow
              label="Claude default"
              hint={
                <>
                  Forwarded as <code className="font-mono">--model</code> to
                  the <code className="font-mono">claude</code> CLI. Empty
                  inherits Claude's own default. Registered:{" "}
                  <RegistryHint agent="claude" />.
                </>
              }
              top
            >
              <Input
                value={defaultClaudeModel}
                onChange={(e) => setDefaultClaudeModel(e.target.value)}
                placeholder={registryPlaceholder("claude", modelsQ.data?.models)}
                className="font-mono w-72"
              />
            </InfoRow>
            <InfoRow
              label="Codex default"
              hint={
                <>
                  Forwarded as <code className="font-mono">--model</code> to
                  the <code className="font-mono">codex</code> CLI. Registered:{" "}
                  <RegistryHint agent="codex" />.
                </>
              }
            >
              <Input
                value={defaultCodexModel}
                onChange={(e) => setDefaultCodexModel(e.target.value)}
                placeholder={registryPlaceholder("codex", modelsQ.data?.models)}
                className="font-mono w-72"
              />
            </InfoRow>
            <p className="px-5 py-2 text-[11px] text-ink-500 dark:text-ink-400">
              Per-task overrides live on the spawn dialog and the task
              header — set them there to try a different model for a single
              task without touching the global default.
            </p>
            <InfoRow
              label="Default drive mode"
              hint={
                defaultTaskMode === "terminal" ? (
                  <>
                    New tasks default to <code className="font-mono">terminal</code> —
                    the daemon prepares the worktree and boots the agent CLI
                    inside a per-task tmux pty for you to drive from the Term
                    tab. No streaming runner, no Live/Log/Todos tabs.
                  </>
                ) : (
                  <>
                    New tasks default to <code className="font-mono">managed</code> —
                    the daemon spawns the agent under the streaming runner
                    and feeds events into the Live timeline. The spawn form's
                    drive picker still wins per-task.
                  </>
                )
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {(["managed", "terminal"] as const).map((m) => {
                  const on = defaultTaskMode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setDefaultTaskMode(m)}
                      className={cn(
                        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] transition-colors",
                        on
                          ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                          : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
                      )}
                    >
                      <span className="font-mono">{m}</span>
                    </button>
                  );
                })}
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
              <ThinkingPicker
                value={defaultClaude}
                onChange={setDefaultClaude}
                agent="claude"
              />
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
              <ThinkingPicker
                value={defaultCodex}
                onChange={setDefaultCodex}
                agent="codex"
              />
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
                placeholder={(() => {
                  // Bias toward the cheapest registered model since
                  // helpers run often. Fall through if the registry
                  // doesn't tag tiers.
                  const list = modelsQ.data?.models.claude ?? [];
                  const fast = list.find((m) => m.tier === "fast") ?? list[0];
                  return fast ? `(inherit) e.g. ${fast.id}` : "(inherit)";
                })()}
                className="font-mono w-72"
              />
            </InfoRow>
            <InfoRow
              label="Effort"
              hint="higher → better wording, slower & more expensive"
            >
              <ThinkingPicker value={helperEffort} onChange={setHelperEffort} />
            </InfoRow>
            <div className="px-5 pt-3 pb-1 text-[10px] uppercase tracking-[0.12em] font-mono text-ink-400 dark:text-ink-500">
              Per-helper overrides
            </div>
            <InfoRow
              label="Commit · model"
              hint={
                <>
                  Override the model for commit-message generation only. Blank
                  inherits the shared default above.
                </>
              }
            >
              <Input
                value={helperCommitModel}
                onChange={(e) => setHelperCommitModel(e.target.value)}
                placeholder="(inherit)"
                className="font-mono w-72"
              />
            </InfoRow>
            <InfoRow
              label="Commit · effort"
              hint="Defaults to inherit. Pick a tier to pin a different effort just for commit subjects."
            >
              <OptionalThinkingPicker
                value={helperCommitEffort}
                onChange={setHelperCommitEffort}
              />
            </InfoRow>
            <InfoRow
              label="PR · model"
              hint={
                <>
                  Override the model for streaming PR title + body. Blank
                  inherits the shared default above. PR bodies often benefit
                  from a deeper model than commits.
                </>
              }
            >
              <Input
                value={helperPrModel}
                onChange={(e) => setHelperPrModel(e.target.value)}
                placeholder="(inherit)"
                className="font-mono w-72"
              />
            </InfoRow>
            <InfoRow
              label="PR · effort"
              hint="Defaults to inherit. Pick a tier to pin a different effort just for PR generation."
            >
              <OptionalThinkingPicker
                value={helperPrEffort}
                onChange={setHelperPrEffort}
              />
            </InfoRow>
          </div>

          {/* Commits & PRs — free-form guidance the AI helper appends */}
          <div id="section-commits">
            <SectionHeader
              label="Commits & PRs"
              hint="free-form guidance appended to the AI helper's prompt"
              sticky
            />
            <InfoRow
              label="Commit instructions"
              hint={
                <>
                  Plain English rules the helper follows when generating
                  commit messages. Empty by default.
                </>
              }
              top
            >
              <Textarea
                id={cpId}
                rows={5}
                value={commitInstructions}
                onChange={(e) => setCommitInstructions(e.target.value)}
                className="font-mono text-xs"
                placeholder={
                  "e.g. Always lowercase. Skip scope unless one package is touched. Mention affected packages when more than one."
                }
              />
            </InfoRow>
            <InfoRow
              label="PR instructions"
              hint={
                <>
                  Same idea for the streaming PR helper that fills the title +
                  body when you open a pull request.
                </>
              }
              top
            >
              <Textarea
                id={prtId}
                rows={5}
                value={prInstructions}
                onChange={(e) => setPrInstructions(e.target.value)}
                className="font-mono text-xs"
                placeholder={
                  "e.g. Lead with a one-sentence summary. Use a `## Changes` heading then bullets. Skip 'Test plan'."
                }
              />
            </InfoRow>
          </div>

          {/* Adversarial review */}
          <div id="section-review">
            <SectionHeader
              label="Adversarial review"
              hint="separate agent reads every commit before you can open a PR"
              sticky
            />
            <ToggleRow
              label="Enabled"
              hint={
                reviewEnabled
                  ? "A second agent reviews each auto-commit and emits a verdict."
                  : "Off — no reviewer runs after commits. PR open is unrestricted."
              }
              value={reviewEnabled}
              onChange={setReviewEnabled}
            />
            <ToggleRow
              label="Block PR on fail"
              hint={
                reviewBlockOnFail
                  ? "POST /tasks/:id/pr returns 409 unless verdict is approved. Use Override and open PR to ship anyway."
                  : "Verdict is advisory only — PR open is never blocked."
              }
              value={reviewBlockOnFail}
              onChange={setReviewBlockOnFail}
            />
            <InfoRow
              label="Reviewer agent"
              hint="Picks a different agent than the primary so blind spots don't overlap."
            >
              <div className="flex flex-wrap gap-1.5">
                {(["claude", "codex"] as const).map((a) => {
                  const on = reviewAgent === a;
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setReviewAgent(a)}
                      className={cn(
                        "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] transition-colors",
                        on
                          ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                          : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
                      )}
                    >
                      <span className="font-mono">{a}</span>
                    </button>
                  );
                })}
              </div>
            </InfoRow>
            <InfoRow
              label="Reviewer model"
              hint={
                <>
                  Empty inherits{" "}
                  <code className="font-mono text-[10px]">
                    defaultModel.{reviewAgent}
                  </code>
                  . Use a different model than the primary for the most
                  signal.
                </>
              }
            >
              <Input
                value={reviewModel}
                onChange={(e) => setReviewModel(e.target.value)}
                placeholder={(() => {
                  const list = modelsQ.data?.models[reviewAgent] ?? [];
                  const def =
                    list.find((m) => m.tier === "deepest") ?? list[0];
                  return def ? `(inherit) e.g. ${def.id}` : "(inherit)";
                })()}
                className="font-mono w-72"
              />
            </InfoRow>
            <InfoRow
              label="Reviewer effort"
              hint="Higher means slower / deeper critique."
            >
              <ThinkingPicker
                value={reviewThinking}
                onChange={setReviewThinking}
                agent={reviewAgent}
              />
            </InfoRow>
            <InfoRow
              label="Max diff bytes"
              hint="Cap on the diff handed to the reviewer. Larger diffs get truncated with a flag in the prompt."
            >
              <Input
                value={String(reviewMaxDiffBytes)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0) setReviewMaxDiffBytes(n);
                }}
                inputMode="numeric"
                className="font-mono w-36"
              />
            </InfoRow>
            <InfoRow
              label="Timeout (ms)"
              hint="Hard wall-clock kill switch. After this the reviewer is killed and the verdict lands as error."
            >
              <Input
                value={String(reviewTimeoutMs)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n > 0) setReviewTimeoutMs(n);
                }}
                inputMode="numeric"
                className="font-mono w-36"
              />
            </InfoRow>
            {reviewAgent === settingsQ.data?.aiHelpers?.binary &&
              reviewModel === (settingsQ.data?.defaultModel?.[reviewAgent] ?? "") &&
              !reviewModel && (
                <div className="px-5 py-2 text-[10px] text-amber-700 dark:text-amber-300">
                  Reviewer model is identical to the primary's default — the
                  value of adversarial review approaches zero. Pin a
                  different model above.
                </div>
              )}
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
        )}
      </div>

      {/* Sticky save bar — hidden on the Skills tab (Skills has its own
          per-file save model). */}
      {!onSkillsTab && (
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
      )}
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

/**
 * Render the registered models for an agent as an inline list. Reads
 * the `cfg.models` registry at runtime — no hardcoded ids.
 */
function RegistryHint({ agent }: { agent: "claude" | "codex" }) {
  const modelsQ = useModels();
  const list = modelsQ.data?.models[agent] ?? [];
  if (list.length === 0) {
    return (
      <span className="font-mono text-[10px] text-ink-400 dark:text-ink-500">
        (none — set in ~/.agentd/config.json under{" "}
        <code className="font-mono">models.{agent}</code>)
      </span>
    );
  }
  return (
    <>
      {list.map((m, i) => (
        <span key={m.id}>
          <code className="font-mono text-[10px]">{m.id}</code>
          {i < list.length - 1 ? ", " : ""}
        </span>
      ))}
    </>
  );
}

/** Produce a sensible placeholder from the first registry entry. */
function registryPlaceholder(
  agent: "claude" | "codex",
  registry: AgentdModelRegistry | undefined,
): string {
  const first = registry?.[agent]?.[0];
  return first ? `(inherit) e.g. ${first.id}` : "(inherit)";
}

function ThinkingPicker({
  value,
  onChange,
  agent,
}: {
  value: ThinkingLevel;
  onChange: (next: ThinkingLevel) => void;
  /**
   * Constrain the picker to one agent's accepted levels. Omit for the
   * helper-effort picker, which is agent-agnostic (the runner clamps).
   */
  agent?: "claude" | "codex";
}) {
  const levels = agent
    ? THINKING_LEVELS_BY_AGENT[agent]
    : (Object.keys(THINKING_LEVEL_META) as ThinkingLevel[]);
  return (
    <div className="flex flex-wrap gap-1.5">
      {levels.map((v) => {
        const meta = THINKING_LEVEL_META[v];
        const on = value === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            title={meta.hint}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] transition-colors",
              on
                ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
            )}
          >
            <span className="font-mono">{meta.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Variant of ThinkingPicker that includes a leading "inherit" pill.
 * Used for per-helper overrides where blank should mean "fall back to
 * the shared default" instead of forcing the operator to pick a tier.
 */
function OptionalThinkingPicker({
  value,
  onChange,
}: {
  value: ThinkingLevel | "";
  onChange: (next: ThinkingLevel | "") => void;
}) {
  const levels = Object.keys(THINKING_LEVEL_META) as ThinkingLevel[];
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={() => onChange("")}
        className={cn(
          "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] transition-colors",
          value === ""
            ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
            : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
        )}
      >
        <span className="font-mono">inherit</span>
      </button>
      {levels.map((v) => {
        const meta = THINKING_LEVEL_META[v];
        const on = value === v;
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            title={meta.hint}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-[11px] transition-colors",
              on
                ? "border-ember-500/40 bg-ember-500/10 text-ember-700 dark:text-ember-300"
                : "border-ink-900/10 bg-paper-50 text-ink-500 hover:border-ink-900/25 hover:text-ink-900 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:text-ink-50",
            )}
          >
            <span className="font-mono">{meta.label}</span>
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
