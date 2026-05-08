import type {
  ActiveIdeaTurn,
  AgentEvent,
  Project,
  ProviderRateLimit,
  Suggestion,
  Task,
  TerminalSession,
  TerminalWindow,
  Trigger,
} from "@agentd/contracts";

export type TaskEventEnvelope = {
  taskId: string;
  event: AgentEvent;
  ts: number;
};

/**
 * Non-task system events that the daemon pushes to all subscribers. Today
 * this is just terminal-session changes — when something mutates the tmux
 * session list (create/kill/rename) or the windows of a specific session,
 * we broadcast the new snapshot so connected web clients update their
 * caches immediately, no polling needed.
 */
export type SystemEvent =
  | {
      kind: "terminal_sessions";
      sessions: TerminalSession[];
    }
  | {
      kind: "terminal_windows";
      sessionName: string;
      windows: TerminalWindow[];
    }
  | {
      /**
       * A new ideation suggestion just landed. Subscribers (web inbox,
       * Telegram bot, etc.) format and present it. Replies route to
       * `/suggestions/:id/reply`.
       */
      kind: "suggestion_created";
      suggestion: Suggestion;
    }
  | {
      /** A suggestion got resolved or dismissed. UIs use this to dim/hide it. */
      kind: "suggestion_updated";
      suggestion: Suggestion;
    }
  | {
      /**
       * A suggestion was hard-deleted (TTL sweep or explicit purge). UIs
       * drop it from any list and close any open brainstorm window pinned
       * to this id.
       */
      kind: "suggestion_removed";
      suggestionId: string;
      projectId: string | null;
    }
  /**
   * Task / project mutations. Realtime principle: every state
   * change visible across surfaces (web, telegram, discord, CLI)
   * gets broadcast so connected clients update without polling.
   * Whether the change came from a web button, a Telegram /new, a
   * Discord reply, or an internal hook, it lands here.
   */
  | { kind: "task_changed"; task: Task }
  | { kind: "task_removed"; taskId: string }
  | { kind: "project_changed"; project: Project }
  | { kind: "project_created"; project: Project }
  | { kind: "project_removed"; projectId: string }
  /**
   * Daemon → discord-subprocess command. The discord plugin watches
   * the bus for these and acts on them (test-send a message, spawn
   * a per-task thread, archive a thread on task close). Other
   * subscribers see the type and ignore.
   */
  | {
      kind: "discord_test_send";
      channelId: string;
      text: string;
      requestId: string;
    }
  | {
      kind: "discord_create_thread";
      channelId: string;
      name: string;
      requestId: string;
    }
  | {
      kind: "discord_archive_thread";
      threadId: string;
      requestId: string;
    }
  /** A plugin successfully delivered a message — bumps live stats. */
  | {
      kind: "plugin_delivery";
      projectId: string | null;
      platform: "telegram" | "discord";
    }
  /** Discord subprocess re-reported its guild/channel snapshot. */
  | { kind: "discord_channels_updated" }
  /**
   * Codex's `~/.codex/models_cache.json` was rewritten — codex talked
   * to its API and got a fresh model list. Or the operator edited
   * `cfg.models.*` in `~/.agentd/config.json`. Web invalidates its
   * cached model registry so the next picker open shows the new
   * roster automatically. No polling.
   */
  | { kind: "models_changed" }
  /**
   * Saved idea created, mutated (status / message / planDraft / etc.),
   * or removed. Web invalidates its cached saved-ideas list +
   * per-idea queries so every device picks up new drafts and
   * conversation messages without polling.
   */
  | { kind: "saved_idea_changed"; ideaId: string; projectId: string | null }
  | {
      kind: "saved_idea_removed";
      ideaId: string;
      projectId: string | null;
    }
  /**
   * Live progress for an in-flight idea turn (chat / plan / challenge).
   * Throttled by the daemon and broadcast over the WS bus so any open
   * surface sees deltas without holding the original streaming HTTP
   * request — the helper keeps running even after the operator
   * navigates away. `turn: null` means the turn just ended.
   */
  | { kind: "idea_turn"; ideaId: string; turn: ActiveIdeaTurn | null }
  /**
   * GitHub state for a project shifted — operator triggered a refresh,
   * a PR action just completed, the status probe re-ran, etc. Web
   * invalidates issue/PR list queries on this so every connected
   * client picks up the new state without polling.
   */
  | { kind: "github_refreshed"; projectId: string }
  /**
   * Runner-reported rate-limit snapshot for a provider account.
   * Today only claude emits these; the daemon mirrors the latest
   * window into the singleton row keyed by provider and fans out
   * the full snapshot so every connected surface sees the new
   * state at once.
   */
  | { kind: "provider_rate_limit_updated"; rateLimit: ProviderRateLimit }
  /**
   * Conditional task trigger lifecycle. Fired on create/update/delete
   * (so all surfaces refresh their list) and again on `trigger_fired`
   * with the spawned task id so UIs can render a deep-link toast.
   */
  | { kind: "trigger_created"; trigger: Trigger }
  | { kind: "trigger_updated"; trigger: Trigger }
  | { kind: "trigger_deleted"; triggerId: string }
  | { kind: "trigger_fired"; trigger: Trigger; taskId: string | null };

export type SystemEventEnvelope = {
  event: SystemEvent;
  ts: number;
};

type Listener = (envelope: TaskEventEnvelope) => void;
type SystemListener = (envelope: SystemEventEnvelope) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private byTask = new Map<string, Set<Listener>>();
  private systemListeners = new Set<SystemListener>();

  publish(envelope: TaskEventEnvelope): void {
    for (const l of this.listeners) {
      try {
        l(envelope);
      } catch {
        // listener errors must not break the bus
      }
    }
    const taskListeners = this.byTask.get(envelope.taskId);
    if (taskListeners) {
      for (const l of taskListeners) {
        try {
          l(envelope);
        } catch {
          // swallow
        }
      }
    }
  }

  publishSystem(event: SystemEvent): void {
    const envelope: SystemEventEnvelope = { event, ts: Date.now() };
    for (const l of this.systemListeners) {
      try {
        l(envelope);
      } catch {
        // swallow
      }
    }
  }

  subscribeAll(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  subscribeTask(taskId: string, l: Listener): () => void {
    let set = this.byTask.get(taskId);
    if (!set) {
      set = new Set();
      this.byTask.set(taskId, set);
    }
    set.add(l);
    return () => {
      const s = this.byTask.get(taskId);
      if (!s) return;
      s.delete(l);
      if (s.size === 0) this.byTask.delete(taskId);
    };
  }

  subscribeSystem(l: SystemListener): () => void {
    this.systemListeners.add(l);
    return () => this.systemListeners.delete(l);
  }
}
