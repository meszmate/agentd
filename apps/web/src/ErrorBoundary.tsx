import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

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
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-2xl w-full rounded-lg border border-destructive/40 bg-destructive/5 p-5">
            <h2 className="font-display text-base font-semibold text-destructive">
              Something broke.
            </h2>
            <pre className="mt-3 max-h-[40vh] overflow-auto rounded border border-border bg-surface-1 p-3 font-mono text-xs leading-relaxed">
              {error.message}
              {error.stack ? "\n\n" + error.stack : ""}
            </pre>
            <button
              className="mt-3 inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              onClick={this.reset}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
