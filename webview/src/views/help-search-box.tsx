// The help page's search box. Cmd+F or Ctrl+F jumps to it, since the webview
// has no find bar of its own.

import type { ReactElement } from 'react';
import { useEffect, useRef } from 'react';

function isFindKey(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f';
}

/** The search box. Cmd+F or Ctrl+F jumps to it, and Escape clears it. */
export function SearchBox(props: {
  readonly query: string;
  readonly onChange: (query: string) => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isFindKey(event)) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return (): void => {
      globalThis.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <div className="help-search" role="search">
      <input
        ref={input}
        type="search"
        aria-label="Search help"
        placeholder="Search help: worktree, stop, badge…"
        value={props.query}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
    </div>
  );
}
