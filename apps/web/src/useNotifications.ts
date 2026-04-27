import { useEffect, useRef } from "react";
import type { Task } from "@agentd/contracts";

const PREF_KEY = "agentd.notifications";

type Pref = "ask" | "on" | "off";

export function getNotifPref(): Pref {
  return (localStorage.getItem(PREF_KEY) as Pref) ?? "ask";
}

export function setNotifPref(p: Pref): void {
  localStorage.setItem(PREF_KEY, p);
}

/**
 * Returns true if the browser supports notifications AND the user has granted
 * permission AND their stored preference is "on".
 */
export function notificationsActive(): boolean {
  if (typeof window === "undefined") return false;
  if (!("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;
  return getNotifPref() === "on";
}

/**
 * Ask for permission. Resolves to true if the user granted, false otherwise.
 * No-op (returns current state) if we've already asked.
 */
export async function requestNotifPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") {
    setNotifPref("on");
    return true;
  }
  if (Notification.permission === "denied") {
    setNotifPref("off");
    return false;
  }
  const result = await Notification.requestPermission();
  if (result === "granted") {
    setNotifPref("on");
    return true;
  }
  setNotifPref("off");
  return false;
}

interface NotifyOpts {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
}

export function notify(opts: NotifyOpts): void {
  if (!notificationsActive()) return;
  // Don't pop a notification when the page is already foregrounded — the
  // user can see what happened in the UI.
  if (document.visibilityState === "visible") return;
  const n = new Notification(opts.title, {
    body: opts.body,
    tag: opts.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
  });
  if (opts.url) {
    n.onclick = () => {
      window.focus();
      window.location.href = opts.url!;
      n.close();
    };
  }
}

/**
 * Watch a tasks list and fire a desktop notification when any task transitions
 * from `running` → terminal status (`done`, `failed`, `stopped`). Dedupes by
 * task id + new status so a flapping list doesn't double-notify.
 */
export function useTaskCompletionNotifications(tasks: Task[] | undefined): void {
  const last = useRef<Map<string, Task["status"]>>(new Map());
  useEffect(() => {
    if (!tasks) return;
    const cur = new Map<string, Task["status"]>();
    for (const t of tasks) {
      cur.set(t.id, t.status);
      const prev = last.current.get(t.id);
      // Only fire when we're transitioning from a known earlier state — first
      // time we see a task in any status doesn't notify (avoids a notification
      // burst on page load).
      if (prev && prev !== t.status && (t.status === "done" || t.status === "failed" || t.status === "stopped")) {
        notify({
          title: `agentd: ${t.title}`.slice(0, 80),
          body: `task ${t.id.slice(-8)} → ${t.status}`,
          tag: `task-${t.id}`,
          url: `/tasks/${t.id}`,
        });
      }
    }
    last.current = cur;
  }, [tasks]);
}
