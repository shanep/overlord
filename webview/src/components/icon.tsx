// Small line icons for compact row buttons. They draw in currentColor so
// they follow the theme, and they are decorative: the button carries the name.

import type { ReactElement } from 'react';

const SHAPES = {
  open: <path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" />,
  interrupt: <path d="M6 4v8M10 4v8" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />,
  attach: <path d="m3 5 3 3-3 3M8 11h5" />,
} as const;

export function Icon(props: { readonly name: keyof typeof SHAPES }): ReactElement {
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
