import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { useApplyUpdate, useUpdateInfo } from "@/queries";
import { cn } from "@/lib/utils";

/**
 * Slim banner shown across all routes when the daemon's npm-update check
 * has found a newer version of @meszmate/agentd. Reads from react-query
 * (the cache is patched by realtime.tsx on `update_info` WS events) so
 * the banner appears/disappears within a frame of the daemon noticing.
 *
 * Two affordances:
 *   - "Update now" — only when the daemon is under a service manager
 *     (systemd/launchd). Clicking POSTs to the daemon, which spawns
 *     `bun install -g @meszmate/agentd@latest` and then exits so the
 *     manager restarts us. The WS auto-reconnects and the new version's
 *     UpdateInfo arrives; the banner removes itself.
 *   - Dismiss (X) — per-device + per-version localStorage. If a newer
 *     version ships later, the banner re-appears for that one. This is
 *     the canonical localStorage carve-out (strict per-device concern).
 */
const DISMISS_KEY = "agentd:update-banner-dismissed-version";

export function UpdateBanner() {
  const { data } = useUpdateInfo();
  const info = data?.info;

  const apply = useApplyUpdate();
  // Stay in "restarting…" state from the moment we fire the request
  // through the WS reconnect — the success response is 202 + "updating"
  // but the daemon then exits a few seconds later. Clearing this flag
  // happens on `onSettled` after the realtime layer brings us a fresh
  // UpdateInfo (banner unmounts) or on an error.
  const [restarting, setRestarting] = useState(false);

  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    () => {
      if (typeof window === "undefined") return null;
      return window.localStorage.getItem(DISMISS_KEY);
    },
  );

  if (!info?.updateAvailable || !info.latestVersion) return null;
  if (dismissedVersion && dismissedVersion === info.latestVersion) return null;

  const dismiss = () => {
    if (!info.latestVersion) return;
    window.localStorage.setItem(DISMISS_KEY, info.latestVersion);
    setDismissedVersion(info.latestVersion);
  };

  const onUpdate = () => {
    setRestarting(true);
    apply.mutate(undefined, {
      onError: () => setRestarting(false),
    });
  };

  const canOneClick = info.serviceManaged;
  const errorMsg =
    apply.error instanceof Error ? apply.error.message : null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 border-b border-amber-400/40 bg-amber-50 px-4 py-2 text-xs",
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
        <span className="opacity-70"> — you're on {info.currentVersion}.</span>
        {!canOneClick && (
          <>
            {" "}
            <span className="opacity-70">Update with </span>
            <code className="rounded bg-amber-200/60 px-1 py-0.5 font-mono text-[11px] dark:bg-amber-900/60">
              bun install -g @meszmate/agentd@latest
            </code>
            <span className="opacity-70">
              {" "}
              (or run <code className="font-mono">agentd setup</code> for
              one-click updates).
            </span>
          </>
        )}
        {errorMsg && (
          <span className="block text-amber-800/80 dark:text-amber-200/80">
            update failed: {errorMsg}
          </span>
        )}
      </div>

      {canOneClick ? (
        <button
          type="button"
          onClick={onUpdate}
          disabled={restarting || apply.isPending}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-200/40 px-2.5 py-1 font-medium text-amber-900 transition",
            "hover:bg-amber-200/70",
            "disabled:cursor-wait disabled:opacity-60",
            "dark:border-amber-400/30 dark:bg-amber-800/30 dark:text-amber-100 dark:hover:bg-amber-800/60",
          )}
          title="Run `bun install -g @meszmate/agentd@latest` and restart the daemon"
        >
          {restarting || apply.isPending ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Restarting…
            </>
          ) : (
            <>Update &amp; restart</>
          )}
        </button>
      ) : null}

      <button
        type="button"
        onClick={dismiss}
        className="flex size-6 shrink-0 items-center justify-center rounded text-amber-900/70 hover:bg-amber-200/60 dark:text-amber-100/70 dark:hover:bg-amber-900/60"
        aria-label={`Dismiss update notice for ${info.latestVersion}`}
        title="Dismiss until the next release"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
