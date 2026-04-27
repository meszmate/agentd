import type { AgentEvent } from "@agentd/contracts";

export type TaskEventEnvelope = {
  taskId: string;
  event: AgentEvent;
  ts: number;
};

type Listener = (envelope: TaskEventEnvelope) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private byTask = new Map<string, Set<Listener>>();

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
}
