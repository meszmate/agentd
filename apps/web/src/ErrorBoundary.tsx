import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors from anywhere below in the tree. Without this,
 * a single bad fetch result or null deref blanks the whole app to a white
 * screen, which is the worst possible UX for a tool you reach for from your
 * phone at midnight.
 *
 * Reset is wired so the user can click "try again" and stay in the app
 * instead of having to refresh.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return (
        <div style={{ padding: 24 }}>
          <h2 style={{ marginTop: 0, color: "var(--err)" }}>Something broke.</h2>
          <pre style={{ background: "var(--panel)", padding: 12, borderRadius: 8, overflow: "auto" }}>
            {error.message}
            {error.stack ? "\n\n" + error.stack : ""}
          </pre>
          <button className="primary" onClick={this.reset}>
            try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
