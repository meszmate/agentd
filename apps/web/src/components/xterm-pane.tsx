import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "@/components/theme-provider";

const DARK_THEME = {
  background: "#0a0a0a",
  foreground: "#fafaf9",
  cursor: "#ff5c28",
  selectionBackground: "#ff5c2840",
};
const LIGHT_THEME = {
  background: "#fbf8f1",
  foreground: "#0a0a0a",
  cursor: "#e84416",
  selectionBackground: "#ff5c2840",
};

interface Props {
  /**
   * Build the WebSocket. Called on every (re)connect attempt; the pane handles
   * lifecycle. Return null to render an empty pane.
   */
  connect: () => WebSocket | null;
  /** Stable identity for connect(). When this changes, we tear down + reconnect. */
  connectionKey: string;
  onError?: (m: string) => void;
  /** Render extra status text under the empty state when no key is set. */
  emptyHint?: string;
}

interface PtyServerMessage {
  type: "ready" | "output" | "exit";
  data?: string;
  cwd?: string;
  mode?: string;
  label?: string;
  code?: number | null;
}

type ConnState = "connecting" | "live" | "reconnecting" | "closed";

// Reconnect schedule: quick first retry for transient drops, then back off.
const BACKOFF_MS = [400, 800, 1500, 3000, 5000];

/**
 * Generic xterm.js pane wired to a WebSocket. Sends the pty wire protocol:
 *   client → server : { type: "input", data } | { type: "resize", cols, rows }
 *   server → client : { type: "ready"|"output"|"exit", ... }
 *
 * Reconnects automatically on transient drops. Surfaces a small status pill
 * at the top so users see what's happening instead of a stale terminal.
 */
export function XTermPane({ connect, connectionKey, onError, emptyHint }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { resolved } = useTheme();
  const [conn, setConn] = useState<ConnState>("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!connectionKey) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: 12,
      theme: resolved === "dark" ? DARK_THEME : LIGHT_THEME,
      // Real PTY → tmux handles its own line endings; don't double-convert.
      convertEol: false,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let everOpened = false;
    let exitedCleanly = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (disposed) return;
      setConn(attempt === 0 ? "connecting" : "reconnecting");
      try {
        ws = connect();
      } catch (e) {
        ws = null;
        if (attempt === 0) onError?.((e as Error).message);
      }
      if (!ws) {
        setConn("closed");
        return;
      }
      const sock = ws;

      const sendResize = () => {
        if (sock.readyState !== WebSocket.OPEN) return;
        sock.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
      };

      sock.onopen = () => {
        attempt = 0;
        everOpened = true;
        setConn("live");
        term.focus();
        sendResize();
      };

      // We never surface this as a toast — it fires for benign things too
      // (StrictMode teardown of a still-CONNECTING socket). The close handler
      // decides whether to retry or give up based on what actually happened.
      sock.onerror = () => {
        // intentional no-op; close handler does the real work
      };

      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as PtyServerMessage;
          if (msg.type === "ready") {
            // tmux clears + redraws on attach; no need for our own banner
          } else if (msg.type === "output" && msg.data != null) {
            term.write(msg.data);
          } else if (msg.type === "exit") {
            exitedCleanly = true;
            term.write(
              `\r\n\x1b[2m[disconnected · code=${msg.code ?? "?"}]\x1b[0m\r\n`,
            );
          }
        } catch {
          // ignore unparseable
        }
      };

      sock.onclose = () => {
        if (disposed) return;
        // Server told us the pty exited — don't reconnect, that would just
        // respawn a fresh shell. Stay closed.
        if (exitedCleanly) {
          setConn("closed");
          return;
        }
        // Never opened on first try is usually a 401 (token gone) or daemon
        // down — surface that, then retry once on the chance it was a blip.
        // Subsequent transient drops auto-reconnect with backoff.
        const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
        attempt += 1;
        if (attempt > BACKOFF_MS.length) {
          setConn("closed");
          if (everOpened) {
            term.write(
              "\r\n\x1b[2m[disconnected — gave up reconnecting]\x1b[0m\r\n",
            );
          }
          return;
        }
        setConn("reconnecting");
        reconnectTimer = setTimeout(open, delay);
      };
    };

    open();

    const dataDisp = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeDisp = term.onResize(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
      }
    });

    const onWinResize = () => {
      try {
        fit.fit();
      } catch {
        // container may be 0×0 mid-transition
      }
    };
    window.addEventListener("resize", onWinResize);
    const ro = new ResizeObserver(onWinResize);
    ro.observe(container);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("resize", onWinResize);
      ro.disconnect();
      dataDisp.dispose();
      resizeDisp.dispose();
      try {
        ws?.close();
      } catch {
        // already closed
      }
      term.dispose();
    };
    // connect is captured by-reference per mount, intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionKey, resolved]);

  if (!connectionKey) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-ink-900 text-xs text-ink-400">
        {emptyHint ?? "no session selected"}
      </div>
    );
  }
  return (
    <div className="relative h-full w-full bg-ink-900 p-1.5">
      {conn !== "live" && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-white/80 backdrop-blur">
          <span
            className={
              conn === "closed"
                ? "size-1.5 rounded-full bg-red-500"
                : "size-1.5 rounded-full bg-amber-400 animate-pulse"
            }
          />
          {conn === "connecting"
            ? "connecting"
            : conn === "reconnecting"
              ? "reconnecting"
              : "disconnected"}
        </div>
      )}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
