import { useEffect, useRef } from "react";
import type { AgentdUserPrefs } from "@agentd/client";
import { useApp } from "@/AppContext";
import { usePatchPrefs } from "@/queries";

/**
 * One-time migration from the old per-device localStorage keys to the
 * server-side `prefs` block. Runs once per browser when:
 *   - the user is signed in (we have a client), AND
 *   - the migration sentinel has not been set yet.
 *
 * After upgrading from the old build the user keeps their prior picks
 * (last agent, repo, thinking level, pinned repos, expanded projects,
 * task workspace panel state) instead of seeing fresh defaults.
 *
 * Idempotent: the sentinel `agentd.prefsMigrated.v1` is set after the
 * patch resolves, so the migrator never runs twice. Failures don't set
 * the sentinel — the migrator silently retries on the next mount.
 */
const SENTINEL = "agentd.prefsMigrated.v1";

const LEGACY_KEYS = [
  "agentd.lastRepo",
  "agentd.lastProjectId",
  "agentd.lastBase",
  "agentd.lastAgent",
  "agentd.lastAutoPush",
  "agentd.lastAutoPr",
  "agentd.lastPermissionMode",
  "agentd.lastThinkingLevel",
  "agentd.lastModelClaude",
  "agentd.lastModelCodex",
  "agentd.workspaceSetup",
  "agentd.sidebar.openProjects",
  "agentd.task.workspaceOpen",
  "agentd.pinnedRepos",
] as const;

function readBool(key: string): boolean | undefined {
  const v = localStorage.getItem(key);
  if (v === "1") return true;
  if (v === "0") return false;
  return undefined;
}

function readEnum<T extends string>(
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = localStorage.getItem(key);
  return allowed.includes(v as T) ? (v as T) : undefined;
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function buildPatch(): Partial<AgentdUserPrefs> | null {
  const patch: Partial<AgentdUserPrefs> = {};
  let any = false;
  const set = <K extends keyof AgentdUserPrefs>(
    k: K,
    v: AgentdUserPrefs[K] | undefined,
  ) => {
    if (v !== undefined) {
      patch[k] = v;
      any = true;
    }
  };

  set("lastRepo", localStorage.getItem("agentd.lastRepo") ?? undefined);
  set(
    "lastProjectId",
    localStorage.getItem("agentd.lastProjectId") ?? undefined,
  );
  set("lastBase", localStorage.getItem("agentd.lastBase") ?? undefined);
  set("lastAgent", readEnum("agentd.lastAgent", ["claude", "codex"] as const));
  set("lastAutoPush", readBool("agentd.lastAutoPush"));
  set("lastAutoPr", readBool("agentd.lastAutoPr"));
  set(
    "lastPermissionMode",
    readEnum("agentd.lastPermissionMode", [
      "bypassPermissions",
      "acceptEdits",
      "plan",
    ] as const),
  );
  set(
    "lastThinkingLevel",
    readEnum("agentd.lastThinkingLevel", [
      "low",
      "medium",
      "high",
      "max",
      "xhigh",
    ] as const),
  );
  set(
    "lastModelClaude",
    localStorage.getItem("agentd.lastModelClaude") ?? undefined,
  );
  set(
    "lastModelCodex",
    localStorage.getItem("agentd.lastModelCodex") ?? undefined,
  );

  // Workspace setup was a JSON blob containing some of these fields.
  const ws = readJson<{
    workspaceMode?: AgentdUserPrefs["workspaceMode"];
    branchMode?: AgentdUserPrefs["branchMode"];
    pullLatest?: boolean;
  }>("agentd.workspaceSetup");
  if (ws) {
    set("workspaceMode", ws.workspaceMode);
    set("branchMode", ws.branchMode);
    set("pullLatest", ws.pullLatest);
  }

  // Sidebar expanded projects: stored as { [id]: bool }; we only keep
  // the ids whose value is true.
  const open = readJson<Record<string, boolean>>("agentd.sidebar.openProjects");
  if (open) {
    const ids = Object.entries(open)
      .filter(([, v]) => v)
      .map(([k]) => k);
    set("sidebarExpandedProjects", ids);
  }

  set("taskWorkspaceOpen", readBool("agentd.task.workspaceOpen"));

  const pins = readJson<unknown>("agentd.pinnedRepos");
  if (Array.isArray(pins)) {
    const filtered = pins.filter((s): s is string => typeof s === "string");
    set("repoPickerPins", filtered);
  }

  return any ? patch : null;
}

export function useLegacyPrefsMigration(): void {
  const { client } = useApp();
  const patch = usePatchPrefs();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    if (!client) return;
    if (localStorage.getItem(SENTINEL) === "1") return;
    const body = buildPatch();
    if (!body) {
      // Nothing to migrate — record it as done so we don't keep checking.
      localStorage.setItem(SENTINEL, "1");
      ranRef.current = true;
      return;
    }
    ranRef.current = true;
    void patch
      .mutateAsync(body)
      .then(() => {
        localStorage.setItem(SENTINEL, "1");
        // Clean up the legacy keys so they can't haunt future versions.
        for (const k of LEGACY_KEYS) {
          try {
            localStorage.removeItem(k);
          } catch {
            // best effort
          }
        }
      })
      .catch(() => {
        // Leave the sentinel unset; we'll retry on the next mount. The
        // mutation failure is also surfaced through the toast in the
        // mutation hook itself, no need to double-toast here.
        ranRef.current = false;
      });
  }, [client, patch]);
}
