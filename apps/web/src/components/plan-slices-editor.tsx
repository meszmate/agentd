import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  THINKING_LEVELS_BY_AGENT,
  type AgentKind,
  type PlanSlice,
  type ThinkingLevel,
} from "@agentd/contracts";
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
    <div className="relative">
      {/* Vertical spine connecting the slice badges. Sits behind the
          numbered chips, only visible between the first and last
          slice's center points. */}
      {slices.length > 1 && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-[15px] top-6 bottom-10 w-px bg-gradient-to-b from-ember-500/30 via-ember-500/10 to-transparent"
        />
      )}
      <div className="space-y-2.5">
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
          className="ml-9 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border border-dashed border-ink-900/15 bg-paper-50/50 font-mono text-[10.5px] text-ink-600 hover:border-ember-500/40 hover:bg-ember-500/[0.04] hover:text-ember-700 dark:border-ink-50/15 dark:bg-ink-800/50 dark:text-ink-300 dark:hover:text-ember-300 transition-colors disabled:opacity-50"
        >
          <Plus className="h-3 w-3" /> add slice
        </button>
      </div>
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
  // Brand-tint the slice card based on the chosen agent so the
  // operator can see at a glance which slice will run on which CLI.
  // Default-claude looks ember; codex looks violet.
  const tint = agent === "codex" ? "violet" : "ember";
  return (
    <div className="relative pl-9">
      {/* Numbered badge anchored to the spine. The ring matches the
          slice's tint so the editor reads as a small typographic timeline. */}
      <div
        className={cn(
          "absolute left-0 top-2 inline-flex items-center justify-center h-7 w-7 rounded-full font-mono text-[10.5px] font-semibold tabular-nums ring-2 ring-paper-100 dark:ring-ink-900",
          tint === "ember"
            ? "bg-ember-500/15 text-ember-700 dark:text-ember-300"
            : "bg-violet-500/15 text-violet-700 dark:text-violet-300",
        )}
      >
        {index + 1}
      </div>
      <div
        className={cn(
          "rounded-xl border p-3 space-y-2.5 transition-colors",
          tint === "ember"
            ? "border-ember-500/15 bg-paper-50 hover:border-ember-500/25 dark:bg-ink-800/60"
            : "border-violet-500/15 bg-paper-50 hover:border-violet-500/25 dark:bg-ink-800/60",
        )}
      >
        <div className="flex items-center gap-2">
          <Input
            value={slice.title}
            onChange={(e) => onUpdate({ title: e.target.value })}
            placeholder="title"
            disabled={disabled}
            className="h-7 flex-1 text-[12.5px] font-medium border-transparent bg-transparent focus-visible:bg-paper-100 dark:focus-visible:bg-ink-900"
          />
          <span className="shrink-0 inline-flex items-center gap-0.5">
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
              className="rounded p-1 text-ink-400 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-30"
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
          className="text-[12px] font-mono leading-relaxed resize-y bg-paper-100/60 dark:bg-ink-900/40"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <SmallPick
            label={`agent · ${agent}`}
            tint={tint}
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
            tint={tint}
            options={[
              { value: "", label: "inherit" },
              // Filter by this slice's agent (defaults to claude when
              // unset). Avoids offering `max` to a codex slice or
              // `minimal` to a claude slice.
              ...THINKING_LEVELS_BY_AGENT[slice.agent ?? "claude"].map((v) => ({
                value: v,
                label: v,
              })),
            ]}
            onSelect={(v) =>
              onUpdate({
                thinkingLevel:
                  v === "minimal" ||
                  v === "low" ||
                  v === "medium" ||
                  v === "high" ||
                  v === "xhigh" ||
                  v === "max"
                    ? (v as ThinkingLevel)
                    : undefined,
              })
            }
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}

function SmallPick({
  label,
  options,
  onSelect,
  disabled,
  tint,
}: {
  label: string;
  options: { value: string; label: string }[];
  onSelect: (v: string) => void;
  disabled?: boolean;
  tint?: "ember" | "violet";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1 h-7 px-2.5 rounded-full border font-mono text-[10.5px] transition-colors disabled:opacity-50",
            tint === "ember"
              ? "border-ember-500/20 bg-ember-500/[0.04] text-ember-700 hover:border-ember-500/40 hover:bg-ember-500/[0.08] dark:text-ember-300"
              : tint === "violet"
                ? "border-violet-500/20 bg-violet-500/[0.04] text-violet-700 hover:border-violet-500/40 hover:bg-violet-500/[0.08] dark:text-violet-300"
                : "border-ink-900/10 bg-paper-50 text-ink-700 hover:border-ink-900/25 hover:bg-paper-100 dark:border-ink-50/10 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700",
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
    <div className="inline-flex items-center h-7 rounded-full border border-ink-900/10 bg-paper-50 overflow-hidden focus-within:border-ink-900/25 dark:border-ink-50/10 dark:bg-ink-800">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="model · any"
        disabled={disabled}
        className="h-7 w-[150px] border-0 bg-transparent px-2.5 font-mono text-[10.5px] focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      {suggestions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="inline-flex items-center h-7 w-6 border-l border-ink-900/10 text-ink-500 hover:bg-ink-900/[0.04] dark:border-ink-50/10 dark:text-ink-400 dark:hover:bg-ink-50/[0.04] disabled:opacity-50"
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
