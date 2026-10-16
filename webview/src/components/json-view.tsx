import type { ReactElement } from 'react';

/** Pretty JSON for tool input and other free form values. */
export function formatJson(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify(value, null, 2);
}

export function JsonView(props: { readonly value: unknown }): ReactElement {
  return <pre className="json">{formatJson(props.value)}</pre>;
}
