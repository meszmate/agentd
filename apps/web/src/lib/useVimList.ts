import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Global registry of mounted lists. Pages with multiple lists fall back
 * to the most recently mounted one for j/k/Enter actions — which is
 * almost always the one the user is looking at, and it keeps the API
 * dead simple (no focus-management ceremony required by callers).
 *
 * Each entry is a setter the active list exposes for the global
 * keydown handler to drive. The handler itself is registered once on
 * the document by the first hook user.
 */
interface ListEntry {
  id: number;
  count: number;
  ref: { current: number };
  activate?: (index: number) => void;
  setIndex: (next: (cur: number) => number) => void;
  scrollTo?: (index: number) => void;
}

const lists: ListEntry[] = [];
let nextId = 1;
let listenerAttached = false;
let pendingG = 0; // 0 = idle, 1 = saw lowercase g, awaiting second g

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const t = target.tagName;
  if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return true;
  return false;
}

function activeList(): ListEntry | null {
  for (let i = lists.length - 1; i >= 0; i--) {
    const l = lists[i]!;
    if (l.count > 0) return l;
  }
  return null;
}

function attachListenerOnce(): void {
  if (listenerAttached) return;
  listenerAttached = true;

  const handler = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (inEditable(e.target)) return;
    const list = activeList();
    if (!list) return;
    const max = Math.max(0, list.count - 1);

    // `gg` chord — first lowercase g arms, second jumps to top.
    if (e.key === "g" && !e.shiftKey) {
      if (pendingG === 1) {
        e.preventDefault();
        list.setIndex(() => 0);
        list.scrollTo?.(0);
        pendingG = 0;
        return;
      }
      pendingG = 1;
      // Auto-clear after 800ms so the chord doesn't haunt later keystrokes.
      setTimeout(() => {
        if (pendingG === 1) pendingG = 0;
      }, 800);
      return;
    }
    // Anything else cancels a primed `g`.
    pendingG = 0;

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      list.setIndex((cur) => Math.min(max, cur + 1));
      list.scrollTo?.(Math.min(max, list.ref.current + 1));
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      list.setIndex((cur) => Math.max(0, cur - 1));
      list.scrollTo?.(Math.max(0, list.ref.current - 1));
    } else if (e.key === "G" && e.shiftKey) {
      e.preventDefault();
      list.setIndex(() => max);
      list.scrollTo?.(max);
    } else if (e.key === "Enter") {
      if (list.activate) {
        e.preventDefault();
        list.activate(list.ref.current);
      }
    }
  };

  document.addEventListener("keydown", handler);
}

/**
 * Subscribe a list to global vim navigation.
 *
 *   j / ↓        next
 *   k / ↑        prev
 *   gg           top
 *   G            bottom
 *   Enter        activate (calls onActivate with the focused index)
 *
 * The most recently mounted list wins — pages with one list don't have
 * to think about it. Pages with multiple lists can mount/unmount as the
 * user scrolls into different regions and the right one stays active.
 *
 * Returns:
 *   focused: the current index (clamped if items shrinks)
 *   isFocused(i): convenience predicate for class names
 *   setFocused: imperative override (e.g. when filter changes)
 *   rowRef(i): callback ref to attach to each row so scroll-into-view works
 */
export function useVimList(
  count: number,
  onActivate?: (index: number) => void,
): {
  focused: number;
  isFocused: (i: number) => boolean;
  setFocused: (i: number) => void;
  rowRef: (i: number) => (el: HTMLElement | null) => void;
} {
  const [focused, setFocusedState] = useState(0);
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const rowEls = useRef(new Map<number, HTMLElement>());
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;

  // Clamp when items shrink.
  useEffect(() => {
    if (focused > Math.max(0, count - 1)) {
      setFocusedState(Math.max(0, count - 1));
    }
  }, [count, focused]);

  useEffect(() => {
    attachListenerOnce();
    const id = nextId++;
    const entry: ListEntry = {
      id,
      count,
      ref: focusedRef,
      activate: onActivate
        ? (i) => onActivateRef.current?.(i)
        : undefined,
      setIndex: (fn) => {
        setFocusedState((cur) => {
          const next = fn(cur);
          focusedRef.current = next;
          return next;
        });
      },
      scrollTo: (i) => {
        const el = rowEls.current.get(i);
        if (el)
          el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      },
    };
    lists.push(entry);
    return () => {
      const idx = lists.findIndex((l) => l.id === id);
      if (idx >= 0) lists.splice(idx, 1);
    };
    // The handler reads count via the entry; we update it on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the registered entry's count in sync without re-subscribing.
  useEffect(() => {
    const entry = lists[lists.length - 1];
    if (entry) entry.count = count;
  }, [count]);

  // Re-bind activate on render so callers can close over fresh state.
  useEffect(() => {
    const entry = lists[lists.length - 1];
    if (!entry) return;
    entry.activate = onActivate
      ? (i) => onActivateRef.current?.(i)
      : undefined;
  }, [onActivate]);

  const isFocused = useCallback((i: number) => i === focused, [focused]);
  const setFocused = useCallback((i: number) => {
    setFocusedState(Math.max(0, i));
  }, []);
  const rowRef = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      if (el) rowEls.current.set(i, el);
      else rowEls.current.delete(i);
    },
    [],
  );

  return { focused, isFocused, setFocused, rowRef };
}
