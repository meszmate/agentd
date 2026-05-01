import { useEffect, useRef } from "react";
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
   * Build the WebSocket. Called once per mount; the pane handles lifecycle.
   * Return null to render an empty pane.
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

/**
 * Generic xterm.js pane wired to a WebSocket. Sends the pty wire protocol:
 *   client → server : { type: "input", data } | { type: "resize", cols, rows }
 *   server → client : { type: "ready"|"output"|"exit", ... }
 *
 * Use it via <XTermPane connect={() => client.attachTerminal("dev")} />
 */
export function XTermPane({ connect, connectionKey, onError, emptyHint }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { resolved } = useTheme();

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
    try {
      ws = connect();
    } catch (e) {
      onError?.((e as Error).message);
    }

    const sendResize = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
      );
    };

    if (ws) {
      ws.onopen = () => {
        term.focus();
        sendResize();
      };
      ws.onerror = () => onError?.("terminal: connection error");
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as PtyServerMessage;
          if (msg.type === "ready") {
            // tmux clears + redraws on attach; no need for our own banner
          } else if (msg.type === "output" && msg.data != null) {
            term.write(msg.data);
          } else if (msg.type === "exit") {
            term.write(
              `\r\n\x1b[2m[disconnected · code=${msg.code ?? "?"}]\x1b[0m\r\n`,
            );
          }
        } catch {
          // ignore unparseable
        }
      };
      ws.onclose = () => term.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");
    }

    const dataDisp = term.onData((data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeDisp = term.onResize(() => sendResize());

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
    <div className="h-full w-full bg-ink-900 p-1.5">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
