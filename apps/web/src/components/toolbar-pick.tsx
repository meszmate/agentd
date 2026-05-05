import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ToolbarPickOption {
  value: string;
  label: string;
}

/**
 * Compact dropdown trigger used in the inline composer toolbar (project
 * detail) and the new-task sheet. Renders as a single mono pill: small
 * label + chevron, opens a `DropdownMenu` of options below.
 */
export function ToolbarPick({
  label,
  options,
  onSelect,
  align = "start",
}: {
  label: string;
  options: ToolbarPickOption[];
  onSelect: (v: string) => void;
  align?: "start" | "center" | "end";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 h-7 px-2 rounded border border-ink-900/10 bg-paper-50 font-mono text-[11px] text-ink-700 hover:border-ink-900/25 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700 transition-colors"
        >
          {label}
          <ChevronDown className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[200px]">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)}>
            <span className="font-mono text-[12px]">{o.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Tri-state commit dropdown. We keep `autoCommit` + `autoPush` as the
 * underlying booleans (that's what the contracts and prefs expect) and
 * map them into / out of three operator-facing modes.
 */
export type CommitMode = "none" | "commit" | "commit+push";

export function commitModeLabel(autoCommit: boolean, autoPush: boolean): string {
  if (!autoCommit) return "off";
  return autoPush ? "+push" : "only";
}

export function parseCommitMode(v: string): {
  autoCommit: boolean;
  autoPush: boolean;
} {
  if (v === "none") return { autoCommit: false, autoPush: false };
  if (v === "commit") return { autoCommit: true, autoPush: false };
  return { autoCommit: true, autoPush: true };
}
