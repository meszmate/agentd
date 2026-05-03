import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { AgentKind, PlanSlice } from "@agentd/contracts";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Pure controlled editor for `PlanSlice[]`. The model field is a
 * free-form text input — operators routinely want to pin model ids
 * the registry doesn't carry yet (preview models, internal aliases,
 * a specific dated version). The agent picker is constrained to the
 * two CLIs we know how to spawn.
 *
 * No drag-drop; up/down buttons are enough for 2-5 slice batches and
 * keep the component flat.
 */
export interface PlanSlicesEditorProps {
  slices: PlanSlice[];
  onChange: (next: PlanSlice[]) => void;
  /** Suggestion list for the model picker — operator may also type free-form. */
  modelSuggestions?: { claude: string[]; codex: string[] };
  disabled?: boolean;
}

export function PlanSlicesEditor({
  slices,
  onChange,
  modelSuggestions,
  disabled,
}: PlanSlicesEditorProps) {
  const update = (i: number, patch: Partial<PlanSlice>) => {
    onChange(slices.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };
  const remove = (i: number) => {
    onChange(slices.filter((_, idx) => idx !== i));
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= slices.length) return;
    const next = slices.slice();
    const tmp = next[i]!;
    next[i] = next[j]!;
    next[j] = tmp;
    onChange(next);
  };
  const add = () => {
    onChange([
      ...slices,
      { title: `slice ${slices.length + 1}`, prompt: "" },
    ]);
  };

  return (
    <div className="space-y-2">
      {slices.map((slice, i) => (
        <SliceRow
          key={i}
          index={i}
          total={slices.length}
          slice={slice}
          onUpdate={(p) => update(i, p)}
          onRemove={() => remove(i)}
          onMoveUp={() => move(i, -1)}
          onMoveDown={() => move(i, 1)}
          modelSuggestions={modelSuggestions}
          disabled={disabled}
        />
      ))}
      <button
        type="button"
        onClick={add}
        disabled={disabled}
        className="inline-flex items-center gap-1 h-7 px-2 rounded border border-dashed border-ink-900/15 bg-paper-50 font-mono text-[11px] text-ink-600 hover:border-ink-900/30 hover:bg-paper-100 dark:border-ink-50/15 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700 transition-colors disabled:opacity-50"
      >
        <Plus className="h-3 w-3" /> add slice
      </button>
    </div>
  );
}

function SliceRow({
  index,
  total,
  slice,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  modelSuggestions,
  disabled,
}: {
  index: number;
  total: number;
  slice: PlanSlice;
  onUpdate: (patch: Partial<PlanSlice>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  modelSuggestions?: { claude: string[]; codex: string[] };
  disabled?: boolean;
}) {
  const agent: AgentKind = slice.agent ?? "claude";
  const suggested =
    (modelSuggestions
      ? agent === "claude"
        ? modelSuggestions.claude
        : modelSuggestions.codex
      : []) ?? [];
  return (
    <div className="rounded-lg border border-ink-900/10 bg-paper-50 p-3 space-y-2 dark:border-ink-50/10 dark:bg-ink-800">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">
          slice {index + 1} / {total}
        </span>
        <Input
          value={slice.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          placeholder="title"
          disabled={disabled}
          className="h-7 max-w-[220px] text-[12px]"
        />
        <span className="ml-auto inline-flex items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={disabled || index === 0}
            className="rounded p-1 text-ink-400 hover:bg-ink-900/[0.05] hover:text-ink-700 disabled:opacity-30 dark:hover:bg-ink-50/[0.05] dark:hover:text-ink-200"
            aria-label="Move slice up"
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={disabled || index === total - 1}
            className="rounded p-1 text-ink-400 hover:bg-ink-900/[0.05] hover:text-ink-700 disabled:opacity-30 dark:hover:bg-ink-50/[0.05] dark:hover:text-ink-200"
            aria-label="Move slice down"
          >
            <ArrowDown className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="rounded p-1 text-red-500 hover:bg-red-500/10 disabled:opacity-30"
            aria-label="Remove slice"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      </div>
      <Textarea
        value={slice.prompt}
        onChange={(e) => onUpdate({ prompt: e.target.value })}
        placeholder="prompt for this slice — what should the agent do here?"
        disabled={disabled}
        rows={Math.min(8, Math.max(3, slice.prompt.split("\n").length + 1))}
        className="text-[12px] font-mono leading-relaxed resize-y"
      />
      <div className="flex flex-wrap items-center gap-2">
        <SmallPick
          label={`agent · ${agent}`}
          options={[
            { value: "claude", label: "claude" },
            { value: "codex", label: "codex" },
          ]}
          onSelect={(v) =>
            onUpdate({ agent: v === "claude" || v === "codex" ? v : undefined })
          }
          disabled={disabled}
        />
        <ModelInput
          value={slice.model ?? ""}
          onChange={(v) => onUpdate({ model: v || undefined })}
          suggestions={suggested}
          disabled={disabled}
        />
        <SmallPick
          label={`think · ${slice.thinkingLevel ?? "inherit"}`}
          options={[
            { value: "", label: "inherit" },
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
            { value: "max", label: "max" },
            { value: "xhigh", label: "xhigh" },
          ]}
          onSelect={(v) =>
            onUpdate({
              thinkingLevel:
                v === "low" ||
                v === "medium" ||
                v === "high" ||
                v === "max" ||
                v === "xhigh"
                  ? v
                  : undefined,
            })
          }
          disabled={disabled}
        />
      </div>
    </div>
  );
}

function SmallPick({
  label,
  options,
  onSelect,
  disabled,
}: {
  label: string;
  options: { value: string; label: string }[];
  onSelect: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1 h-6 px-2 rounded border border-ink-900/10 bg-paper-50 font-mono text-[10px] text-ink-700 hover:border-ink-900/25 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700 transition-colors disabled:opacity-50",
          )}
        >
          {label}
          <ChevronDown className="h-2.5 w-2.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onSelect(o.value)}>
            <span className="font-mono text-[11px]">{o.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Free-form model field — the operator can type any model id, and the
 * registry suggestions act as quick-pick shortcuts. We never constrain
 * to the registry because preview / pinned versions matter.
 */
function ModelInput({
  value,
  onChange,
  suggestions,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="model · any"
        disabled={disabled}
        className="h-6 w-[160px] font-mono text-[10.5px]"
      />
      {suggestions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="inline-flex items-center h-6 px-1 rounded border border-ink-900/10 bg-paper-50 text-ink-500 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-400 dark:hover:bg-ink-700 disabled:opacity-50"
              aria-label="Pick a model"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onChange("")}>
              <span className="font-mono text-[11px]">(inherit)</span>
            </DropdownMenuItem>
            {suggestions.map((s) => (
              <DropdownMenuItem key={s} onClick={() => onChange(s)}>
                <span className="font-mono text-[11px]">{s}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
