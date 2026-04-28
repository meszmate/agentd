import { useEffect, useId, useRef, useState } from "react";
import {
  Bell,
  BellOff,
  GitCommit,
  GitPullRequest,
  Loader2,
  Save,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { usePatchSettings, useSettings } from "@/queries";
import { useApp } from "@/AppContext";
import {
  getNotifPref,
  requestNotifPermission,
  setNotifPref,
} from "@/useNotifications";

export function Settings() {
  const { toast } = useApp();
  const settingsQ = useSettings();
  const patch = usePatchSettings();

  const [agentInstructions, setAgentInstructions] = useState("");
  const [commitPrefix, setCommitPrefix] = useState("");
  const [prTitlePrefix, setPrTitlePrefix] = useState("");
  const [prBodyTemplate, setPrBodyTemplate] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);

  const aiId = useId();
  const cpId = useId();
  const prtId = useId();
  const prbId = useId();

  useEffect(() => {
    if (!settingsQ.data || hydrated) return;
    setAgentInstructions(settingsQ.data.agentInstructions);
    setCommitPrefix(settingsQ.data.commitPrefix);
    setPrTitlePrefix(settingsQ.data.prTitlePrefix);
    setPrBodyTemplate(settingsQ.data.prBodyTemplate);
    setHydrated(true);
  }, [settingsQ.data, hydrated]);

  useEffect(() => {
    if (!hydrated || !settingsQ.data) return;
    const isDirty =
      agentInstructions !== settingsQ.data.agentInstructions ||
      commitPrefix !== settingsQ.data.commitPrefix ||
      prTitlePrefix !== settingsQ.data.prTitlePrefix ||
      prBodyTemplate !== settingsQ.data.prBodyTemplate;
    setDirty(isDirty);
  }, [
    agentInstructions,
    commitPrefix,
    prTitlePrefix,
    prBodyTemplate,
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

  async function save() {
    try {
      await patch.mutateAsync({
        agentInstructions,
        commitPrefix,
        prTitlePrefix,
        prBodyTemplate,
      });
      toast("Settings saved");
    } catch (e) {
      toast((e as Error).message, true);
    }
  }

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-500 dark:text-ink-400">
        Loading settings…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 lg:px-10 py-8 lg:py-10">
        <header className="rise rise-1 flex items-end justify-between gap-4 mb-8">
          <div>
            <div className="label-section mb-2">Account</div>
            <h1 className="display text-4xl sm:text-5xl text-ink-900 dark:text-ink-50">
              Settings
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-ink-500 dark:text-ink-400">
              Server-side daemon configuration. Changes apply to all future
              agent runs.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dirty && <Badge variant="vermilion">unsaved</Badge>}
            <Button onClick={save} disabled={patch.isPending || !dirty}>
              {patch.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
              <Kbd className="ml-1 border-cream-50/20 bg-cream-50/10 text-cream-50/80">
                ⌘S
              </Kbd>
            </Button>
          </div>
        </header>

        <div className="rise rise-2 space-y-10">
          <Section
            icon={<Sparkles className="h-4 w-4" />}
            title="Agent policy"
            description={
              <>
                Appended to every agent run via{" "}
                <span className="font-mono">--append-system-prompt</span>.
              </>
            }
          >
            <Field>
              <Label htmlFor={aiId}>System prompt suffix</Label>
              <Textarea
                id={aiId}
                rows={6}
                value={agentInstructions}
                onChange={(e) => setAgentInstructions(e.target.value)}
                className="font-mono text-xs"
                placeholder="Suppress model self-references and attribution trailers in any output."
              />
            </Field>
          </Section>

          <Section
            icon={<GitCommit className="h-4 w-4" />}
            title="Commits & PRs"
            description={
              <>
                Templates used for auto-commit messages and{" "}
                <span className="font-mono">gh pr create</span>.
              </>
            }
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field>
                <Label htmlFor={cpId}>Commit prefix</Label>
                <Input
                  id={cpId}
                  value={commitPrefix}
                  onChange={(e) => setCommitPrefix(e.target.value)}
                  placeholder="agentd: "
                  className="font-mono"
                />
              </Field>
              <Field>
                <Label htmlFor={prtId}>PR title prefix</Label>
                <Input
                  id={prtId}
                  value={prTitlePrefix}
                  onChange={(e) => setPrTitlePrefix(e.target.value)}
                  placeholder="agentd: "
                  className="font-mono"
                />
              </Field>
            </div>
            <Field>
              <Label htmlFor={prbId} className="flex items-center gap-2">
                <GitPullRequest className="h-3 w-3" />
                PR body template
              </Label>
              <Textarea
                id={prbId}
                rows={6}
                value={prBodyTemplate}
                onChange={(e) => setPrBodyTemplate(e.target.value)}
                className="font-mono text-xs"
              />
              <div className="flex flex-wrap items-center gap-1 pt-1">
                <span className="text-2xs text-ink-500 dark:text-ink-400">
                  Placeholders:
                </span>
                {["{prompt}", "{title}", "{task_id}", "{branch}"].map((p) => (
                  <code
                    key={p}
                    className="rounded border border-ink-900/10 bg-ink-900/[0.04] px-1 py-0.5 font-mono text-2xs text-ink-700 dark:border-ink-50/10 dark:bg-ink-50/[0.04] dark:text-ink-300"
                  >
                    {p}
                  </code>
                ))}
              </div>
            </Field>
          </Section>

          <Section
            icon={<Bell className="h-4 w-4" />}
            title="Browser"
            description="Local-only preferences for this device."
          >
            <NotificationsRow />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-4 flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-ink-900/10 bg-ink-900/[0.03] text-ink-500 dark:border-ink-50/10 dark:bg-ink-50/[0.03] dark:text-ink-400">
          {icon}
        </div>
        <div>
          <h2 className="display text-2xl text-ink-900 dark:text-ink-50">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 text-xs text-ink-500 dark:text-ink-400">
              {description}
            </p>
          )}
        </div>
      </header>
      <div className="space-y-4 pl-11">{children}</div>
    </section>
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
    <label className="flex items-center justify-between gap-3 rounded-xl border border-ink-900/10 bg-ink-900/[0.02] p-3 cursor-pointer dark:border-ink-50/10 dark:bg-ink-50/[0.02]">
      <div className="flex gap-3 items-start">
        <div className="mt-0.5">
          {enabled ? (
            <Bell className="h-4 w-4 text-vermilion-500" />
          ) : (
            <BellOff className="h-4 w-4 text-ink-400 dark:text-ink-500" />
          )}
        </div>
        <div>
          <div className="text-sm font-medium">Desktop notifications</div>
          <div className="text-2xs text-ink-500 dark:text-ink-400 mt-0.5">
            Ping me when a task transitions to{" "}
            <span className="font-mono">done</span> /{" "}
            <span className="font-mono">failed</span> /{" "}
            <span className="font-mono">stopped</span> while the tab is hidden.
          </div>
        </div>
      </div>
      <Switch checked={enabled} onCheckedChange={(v) => void toggle(v)} />
    </label>
  );
}

function Field({ children }: { children: React.ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}
