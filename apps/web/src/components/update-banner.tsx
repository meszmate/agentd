import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useUpdateInfo } from "@/queries";
import { cn } from "@/lib/utils";

/**
 * Slim banner shown across all routes when the daemon's npm-update check
 * has found a newer version of @meszmate/agentd. Reads from react-query
 * (the cache is patched by realtime.tsx on `update_info` WS events) so
 * the banner appears/disappears within a frame of the daemon noticing.
 *
 * Dismissal is per-device + per-version: localStorage tracks which
 * version the operator dismissed. If a newer version ships later the
 * banner re-appears for that one. This is a strict per-device concern
 * (one device's "I'll update later" is no one else's business) and is
 * the canonical localStorage carve-out per AGENTS.md.
 */
const DISMISS_KEY = "agentd:update-banner-dismissed-version";

export function UpdateBanner() {
  const { data } = useUpdateInfo();
  const info = data?.info;

  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    () => {
      if (typeof window === "undefined") return null;
      return window.localStorage.getItem(DISMISS_KEY);
    },
  );

  // If the daemon snapshot ever shows a NEW latest that differs from the
  // currently-dismissed version, surface the banner again. We don't have to
  // do anything special here — render-gate below handles it — but clearing
  // a stale dismissal helps if the operator manually edited localStorage.
  useEffect(() => {
    if (!info?.latestVersion || !dismissedVersion) return;
    if (info.latestVersion !== dismissedVersion) {
      // leave the stored value; the render-gate compares per render
    }
  }, [info?.latestVersion, dismissedVersion]);

  if (!info?.updateAvailable || !info.latestVersion) return null;
  if (dismissedVersion && dismissedVersion === info.latestVersion) return null;

  const dismiss = () => {
    if (!info.latestVersion) return;
    window.localStorage.setItem(DISMISS_KEY, info.latestVersion);
    setDismissedVersion(info.latestVersion);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b border-amber-400/40 bg-amber-50 px-4 py-2 text-xs",
        "dark:border-amber-500/30 dark:bg-amber-950/40",
      )}
      role="status"
    >
      <span
        aria-hidden
        className="inline-block size-2 shrink-0 rounded-full bg-amber-500"
      />
      <div className="min-w-0 flex-1 text-amber-900 dark:text-amber-100">
        <span className="font-medium">
          agentd {info.latestVersion} is available
        </span>
        <span className="opacity-70"> — you're on {info.currentVersion}. </span>
        <span className="opacity-70">Update with </span>
        <code className="rounded bg-amber-200/60 px-1 py-0.5 font-mono text-[11px] dark:bg-amber-900/60">
          bun install -g @meszmate/agentd@latest
        </code>
        <span className="opacity-70">
          {" "}
          (or run <code className="font-mono">agentd setup</code> once for
          daily auto-update).
        </span>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="flex size-6 shrink-0 items-center justify-center rounded text-amber-900/70 hover:bg-amber-200/60 dark:text-amber-100/70 dark:hover:bg-amber-900/60"
        aria-label={`Dismiss update notice for ${info.latestVersion}`}
        title={`Dismiss until the next release`}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
