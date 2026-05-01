import {
  type EventBus,
  listTmuxWindows,
  tmuxSessionExists,
  type TmuxWindow,
} from "@agentd/core";

/**
 * Out-of-band tmux changes (Ctrl-B + N to switch windows, manual splits in a
 * shared session, etc.) don't go through any agentd API, so the daemon
 * normally has no way to know they happened. This watcher polls tmux for
 * each session that has at least one viewer attached and publishes a
 * `terminal_windows` event whenever the snapshot changes — the web's xterm
 * pane already streams the actual screen redraw, but the tab strip needs
 * the structured snapshot to highlight the right window.
 *
 * The watcher is reference-counted by viewer count: it spins up on the
 * first viewer and stops as soon as the last one detaches, so we don't
 * burn CPU polling sessions nobody is looking at.
 */

const POLL_MS = 1500;

interface WatchEntry {
  refs: number;
  timer: ReturnType<typeof setInterval> | null;
  last: TmuxWindow[] | null;
  inFlight: boolean;
}

export class WindowWatcher {
  private entries = new Map<string, WatchEntry>();

  constructor(private readonly bus: EventBus) {}

  attach(sessionName: string): void {
    const existing = this.entries.get(sessionName);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const entry: WatchEntry = {
      refs: 1,
      timer: null,
      last: null,
      inFlight: false,
    };
    this.entries.set(sessionName, entry);
    // Fire immediately so the first viewer doesn't wait POLL_MS for the
    // first snapshot.
    void this.tick(sessionName);
    entry.timer = setInterval(() => {
      void this.tick(sessionName);
    }, POLL_MS);
  }

  detach(sessionName: string): void {
    const entry = this.entries.get(sessionName);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (entry.timer) clearInterval(entry.timer);
    this.entries.delete(sessionName);
  }

  private async tick(sessionName: string): Promise<void> {
    const entry = this.entries.get(sessionName);
    if (!entry || entry.inFlight) return;
    entry.inFlight = true;
    try {
      if (!(await tmuxSessionExists(sessionName))) {
        // Session gone — push an empty snapshot once so the UI clears, then
        // stop polling. The viewer's WS will close on its own when the PTY
        // child exits.
        if (entry.last !== null) {
          entry.last = [];
          this.bus.publishSystem({
            kind: "terminal_windows",
            sessionName,
            windows: [],
          });
        }
        return;
      }
      const windows = await listTmuxWindows(sessionName);
      if (this.differs(entry.last, windows)) {
        entry.last = windows;
        this.bus.publishSystem({
          kind: "terminal_windows",
          sessionName,
          windows,
        });
      }
    } catch {
      // tmux died mid-poll, swallow
    } finally {
      entry.inFlight = false;
    }
  }

  private differs(
    prev: TmuxWindow[] | null,
    next: TmuxWindow[],
  ): boolean {
    if (prev === null) return true;
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i += 1) {
      const a = prev[i]!;
      const b = next[i]!;
      if (
        a.index !== b.index ||
        a.name !== b.name ||
        a.active !== b.active ||
        a.panes !== b.panes
        // Skip `activity` — it ticks on every keystroke and would make
        // every poll churn an event.
      ) {
        return true;
      }
    }
    return false;
  }
}
