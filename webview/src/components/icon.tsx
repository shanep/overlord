// Small line icons for compact row buttons and markers. They draw in
// currentColor so they follow the theme, and they are decorative: the button
// or marker around them carries the name.

import type { ReactElement } from 'react';

const PENCIL = <path d="m10.5 3 2.5 2.5L6 12.5H3.5V10zM9 4.5 11.5 7" />;

const SHAPES = {
  open: <path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5" />,
  /** A magnifying glass: the Context Inspector. */
  context: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="m10 10 3.5 3.5" />
    </>
  ),
  interrupt: <path d="M6 4v8M10 4v8" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />,
  /** A cross: take a launched session out of the fleet. */
  remove: <path d="m4 4 8 8M12 4l-8 8" />,
  /** A terminal window: the CLI in a VS Code terminal. */
  window: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="m5 7 2 1.5L5 10M8.5 10H11" />
    </>
  ),
  /** A bare prompt: the CLI in some other terminal. */
  prompt: <path d="m3 5 3 3-3 3M8 11h5" />,
  /** A folder with an arrow: move to another project. */
  move: <path d="M2 4.5h4l1.5 1.5H14v6.5H2zM7 9.5h4M9.5 8l1.5 1.5L9.5 11" />,
  /** An arrow into a folder: continue the session in another folder. */
  relocate: <path d="M2 2.5V6a2 2 0 0 0 2 2h2.5M5 6.5 6.5 8 5 9.5M8 7h2.5l1 1H14v5H8z" />,
  /** Two lines joining into one: combine sessions. */
  combine: <path d="M3 3v2.5c0 2 5 2.5 5 5V13M13 3v2.5c0 2-5 2.5-5 5M6 11l2 2 2-2" />,
  /** An open folder: show the project's folder in the Explorer. */
  openFolder: <path d="M2 12.5V3.5h4L7.5 5H12v2M2 12.5 4 7h10.5l-2 5.5z" />,
  /** A folder with a plus: choose the project's folder. */
  setFolder: <path d="M2 4.5h4l1.5 1.5H14v6.5H2zM8 7.5v3.5M6.25 9.25h3.5" />,
  /** A pencil: rename. */
  rename: PENCIL,
  renameSession: PENCIL,
  /** A bin: delete. */
  delete: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />,
  /**
   * VS Code's sparkle codicon, traced from its font, so the button matches the
   * New Claude Code Session sparkle at the top of the Fleet. It is a filled
   * outline like every codicon, not a stroke.
   */
  newSession: (
    <path
      fill="currentColor"
      stroke="none"
      d="M5.44 9.81Q5.71 9.97 6 10Q6.29 10.03 6.53 9.84Q6.77 9.65 6.88 9.39L7.2 8.32Q7.36 7.95 7.65 7.65Q7.95 7.36 8.32 7.2L9.39 6.88Q9.65 6.77 9.84 6.53Q10.03 6.29 10.03 6Q10.03 5.71 9.84 5.47Q9.65 5.23 9.33 5.12L8.27 4.8Q7.89 4.64 7.6 4.35Q7.31 4.05 7.2 3.68L6.83 2.61Q6.77 2.35 6.53 2.19Q6.29 2.03 6 2.03Q5.71 2.03 5.44 2.19Q5.17 2.35 5.12 2.61L4.75 3.73Q4.64 4.11 4.35 4.37Q4.05 4.64 3.68 4.8L2.61 5.12Q2.35 5.23 2.16 5.47Q1.97 5.71 2 6Q2.03 6.29 2.19 6.53Q2.35 6.77 2.61 6.88L3.68 7.2Q4.05 7.36 4.37 7.63L4.48 7.79Q4.69 8 4.8 8.32L5.12 9.39Q5.23 9.65 5.44 9.81ZM4 6.24 3.15 5.97 4 5.71Q4.64 5.49 5.07 5.04Q5.49 4.59 5.71 4L5.97 3.15L6.24 4Q6.45 4.64 6.91 5.09Q7.36 5.55 7.95 5.71L8.85 5.97L8 6.29Q7.36 6.45 6.91 6.91Q6.45 7.36 6.29 8L6.03 8.85L5.71 8Q5.6 7.52 5.28 7.2L5.07 6.93Q4.64 6.45 4 6.24ZM10.56 13.87Q10.72 13.97 10.99 13.97Q11.25 13.97 11.47 13.84Q11.68 13.71 11.73 13.44L12 12.69Q12.11 12.43 12.27 12.27Q12.43 12.11 12.69 12L13.44 11.73Q13.71 11.68 13.84 11.49Q13.97 11.31 14 11.12Q14.03 10.93 13.97 10.75Q13.92 10.56 13.76 10.43Q13.6 10.29 13.44 10.24L12.69 9.97Q12.43 9.92 12.24 9.73Q12.05 9.55 12 9.33L11.73 8.53Q11.68 8.27 11.49 8.16Q11.31 8.05 11.12 8.03Q10.93 8 10.75 8.05Q10.56 8.11 10.43 8.24Q10.29 8.37 10.24 8.53L9.97 9.28Q9.92 9.55 9.73 9.73Q9.55 9.92 9.33 9.97L8.53 10.24Q8.37 10.29 8.24 10.43Q8.11 10.56 8.05 10.75Q8 10.93 8.03 11.12Q8.05 11.31 8.19 11.49Q8.32 11.68 8.53 11.73L9.33 12Q9.55 12.11 9.73 12.27Q9.92 12.43 9.97 12.69L10.24 13.44Q10.35 13.71 10.56 13.87ZM9.6 11.04 9.44 10.99 9.6 10.93Q10.08 10.77 10.43 10.43Q10.77 10.08 10.93 9.6L10.99 9.44L11.04 9.6Q11.2 10.08 11.55 10.43Q11.89 10.77 12.37 10.93L12.53 10.99L12.37 11.04Q11.89 11.2 11.55 11.55Q11.2 11.89 11.04 12.37L10.99 12.59L10.93 12.37Q10.77 11.89 10.43 11.55Q10.08 11.2 9.6 11.04Z"
    />
  ),
  /** Sliders: choose what a list shows. */
  sliders: (
    <>
      <path d="M2 4.5h12M2 11.5h12" />
      <circle cx="5.5" cy="4.5" r="1.5" fill="currentColor" />
      <circle cx="10.5" cy="11.5" r="1.5" fill="currentColor" />
    </>
  ),
  /** Stacked layers: running in the background. */
  layers: <path d="M2 6.5 8 3.5l6 3-6 3zM2 9.5l6 3 6-3" />,
  /** A rocket: started from the Launcher. */
  launched: (
    <>
      <path d="M8 1.5c2.5 1.5 3.5 4 3.5 6.5v3h-7V8c0-2.5 1-5 3.5-6.5zM4.5 9 2.5 11v2l2-1M11.5 9l2 2v2l-2-1M6.5 13.5 8 15l1.5-1.5" />
      <circle cx="8" cy="6.5" r="1" />
    </>
  ),
  /** An hourglass: quiet with no window, so it leaves the fleet in time. */
  hourglass: (
    <path d="M4 2.5h8M4 13.5h8M5 2.5c0 3.5 6 3 6 5.5s-6 2-6 5.5M11 2.5c0 3.5-6 3-6 5.5s6 2 6 5.5" />
  ),
} as const;

export type IconName = keyof typeof SHAPES;

/** The webview has no codicon font, so an agent's codicon id maps to a drawn shape, a prompt by default. */
const AGENT_ICONS: Readonly<Record<string, IconName>> = {
  sparkle: 'newSession',
  terminal: 'window',
};

export function agentIcon(codicon: string): IconName {
  return AGENT_ICONS[codicon] ?? 'prompt';
}

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
