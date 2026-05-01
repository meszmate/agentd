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
  { id: "commits", glyph: "◆", label: "Commits & PRs" },
  { id: "browser", glyph: "▢", label: "Browser" },
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
    setHydrated(true);
  }, [settingsQ.data, hydrated]);

  useEffect(() => {
    if (!hydrated || !settingsQ.data) return;
    const isDirty =
      agentInstructions !== settingsQ.data.agentInstructions ||
      commitPrefix !== settingsQ.data.commitPrefix ||
      prTitlePrefix !== settingsQ.data.prTitlePrefix ||
      prBodyTemplate !== settingsQ.data.prBodyTemplate ||
      maxContextTokens !== (settingsQ.data.maxContextTokens ?? 8000);
    setDirty(isDirty);
  }, [
    agentInstructions,
    commitPrefix,
    prTitlePrefix,
    prBodyTemplate,
    maxContextTokens,
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
