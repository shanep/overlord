import type { ReactElement, ReactNode } from 'react';
import { Component } from 'react';

interface ErrorBoundaryState {
  readonly message: string | null;
}

/** Shows a short message instead of a blank panel when a view throws. */
export class ErrorBoundary extends Component<{ readonly children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override render(): ReactElement {
    if (this.state.message === null) {
      return <>{this.props.children}</>;
    }
    return (
      <div className="error-box" role="alert">
        <p>This view hit an error.</p>
        <pre>{this.state.message}</pre>
      </div>
    );
  }
}
