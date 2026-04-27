import { useEffect } from "react";
import { MOD } from "./useKeyboard";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Cheat-sheet of every keyboard shortcut. Triggered by `?`. Mirrors the
 * actual handler set wired in App.tsx — when you change one, change the
 * other. Kept colocated as one file so the diff is obvious.
 */
export function HelpOverlay({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="cmdk-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--rule)",
            display: "flex",
            alignItems: "baseline",
            gap: 12,
          }}
        >
          <strong style={{ fontSize: 14 }}>Keyboard shortcuts</strong>
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-mute)" }}>
            press <span className="kbd">esc</span> to close
          </span>
        </div>
        <div className="help-grid">
          <section>
            <h4>Global</h4>
            <dl>
              <dt><span className="kbd">{MOD}</span><span className="kbd">K</span></dt>
              <dd>open command palette</dd>
              <dt><span className="kbd">?</span></dt>
              <dd>show this help</dd>
              <dt><span className="kbd">esc</span></dt>
              <dd>close any overlay</dd>
              <dt><span className="kbd">/</span></dt>
              <dd>focus the spawn input</dd>
            </dl>
          </section>
          <section>
            <h4>Navigation</h4>
            <dl>
              <dt><span className="kbd">g</span> <span className="kbd">t</span></dt>
              <dd>tasks</dd>
              <dt><span className="kbd">g</span> <span className="kbd">e</span></dt>
              <dd>templates</dd>
              <dt><span className="kbd">g</span> <span className="kbd">s</span></dt>
              <dd>schedules</dd>
              <dt><span className="kbd">g</span> <span className="kbd">p</span></dt>
              <dd>plugins</dd>
              <dt><span className="kbd">g</span> <span className="kbd">,</span></dt>
              <dd>settings</dd>
              <dt><span className="kbd">g</span> <span className="kbd">h</span></dt>
              <dd>back to /tasks (home)</dd>
            </dl>
          </section>
          <section>
            <h4>Tasks</h4>
            <dl>
              <dt><span className="kbd">j</span> / <span className="kbd">k</span></dt>
              <dd>next / previous task in list</dd>
              <dt><span className="kbd">{MOD}</span><span className="kbd">↵</span></dt>
              <dd>send chat input</dd>
              <dt><span className="kbd">esc</span></dt>
              <dd>close task detail (mobile)</dd>
            </dl>
          </section>
          <section>
            <h4>Theme</h4>
            <dl>
              <dt><span className="kbd">t</span></dt>
              <dd>cycle theme (system → light → dark)</dd>
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
