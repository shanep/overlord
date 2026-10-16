// Small line icons for compact row buttons and markers. They draw in
// currentColor so they follow the theme, and they are decorative: the button
// or marker around them carries the name.

import type { ReactElement } from 'react';

const SHAPES = {
  open: <path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" />,
  interrupt: <path d="M6 4v8M10 4v8" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />,
  /** A terminal window: the CLI in a VS Code terminal. */
  window: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="m5 7 2 1.5L5 10M8.5 10H11" />
    </>
  ),
  /** A bare prompt: the CLI in some other terminal. */
  prompt: <path d="m3 5 3 3-3 3M8 11h5" />,
  /** Stacked layers: running in the background. */
  layers: <path d="M2 6.5 8 3.5l6 3-6 3zM2 9.5l6 3 6-3" />,
} as const;

export type IconName = keyof typeof SHAPES;

export function Icon(props: { readonly name: IconName }): ReactElement {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {SHAPES[props.name]}
    </svg>
  );
}
