// Small line icons for compact row buttons and markers. They draw in
// currentColor so they follow the theme, and they are decorative: the button
// or marker around them carries the name.

import type { ReactElement } from 'react';

import type { AgentInfo } from '../../../src/shared/agents.js';
import { CODEX } from '../../../src/shared/agents.js';

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
  /** VS Code's official Copilot codicon. */
  copilot: (
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M7.06 9.66v1.41a.7.7 0 1 1-1.4 0V9.66a.7.7 0 1 1 1.4 0m2.58-.7a.7.7 0 0 0-.7.7v1.41a.7.7 0 1 0 1.4 0V9.66a.7.7 0 0 0-.7-.7m5.86.31v1.76c0 .72-3.14 3.56-7.5 3.56S.62 11.85.5 11.06V9.23c.08-.59.63-1.58 1.49-1.94.01-.07.02-.13.03-.21.03-.17.06-.36.12-.57-.19-.48-.24-1.02-.24-1.55 0-.82.12-1.66.65-2.33.54-.69 1.4-1.05 2.55-1.18 1.13-.13 2.12.03 2.76.72.05.05.09.1.13.15.04-.05.09-.11.13-.15.64-.69 1.63-.84 2.76-.72 1.15.13 2.01.5 2.55 1.18.53.67.65 1.51.65 2.33 0 .54-.05 1.08-.24 1.55.06.21.09.4.12.57.01.07.02.14.03.21.87.36 1.43 1.38 1.49 1.96M3.31 4.97c0 .74.12 1.1.29 1.29.15.17.49.36 1.35.36.8 0 1.26-.22 1.54-.51.3-.3.49-.78.58-1.46.11-.88-.03-1.31-.23-1.51-.18-.19-.6-.39-1.58-.28-.96.11-1.39.38-1.61.66-.23.29-.35.74-.35 1.46m9.38 2.88-.02-.11c-.46.2-1.01.27-1.62.27-1.07 0-1.93-.31-2.54-.93a4.43 4.43 0 0 1-.51-.7c-.14.25-.31.49-.51.7-.61.62-1.47.93-2.54.93-.61 0-1.16-.08-1.62-.27l-.02.11v3.99c.39.3 2.55 1.34 4.69 1.34s4.3-1.04 4.69-1.34zm0-2.88c0-.72-.12-1.16-.35-1.46-.22-.28-.65-.55-1.61-.66-.98-.11-1.39.09-1.58.28-.19.21-.34.64-.23 1.51.09.68.28 1.15.58 1.46.28.29.73.51 1.54.51.86 0 1.2-.19 1.35-.36.17-.19.29-.55.29-1.29"
    />
  ),
  /** An hourglass: quiet with no window, so it leaves the fleet in time. */
  hourglass: (
    <path d="M4 2.5h8M4 13.5h8M5 2.5c0 3.5 6 3 6 5.5s-6 2-6 5.5M11 2.5c0 3.5-6 3-6 5.5s6 2 6 5.5" />
  ),
  /** OpenAI's logomark, for Codex. Drawn on a 24 unit grid, so it is scaled to 16. */
  openai: (
    <path
      transform="scale(0.6667)"
      fill="currentColor"
      stroke="none"
      d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
    />
  ),
  /** A lightning bolt: energy. */
  energy: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />,
  /** A cloud: emissions. */
  emissions: <path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.6-.9 3 3 0 0 1-.2 6.9z" />,
  /** A drop: water. */
  water: <path d="M8 2s4.5 5 4.5 8a4.5 4.5 0 0 1-9 0C3.5 7 8 2 8 2z" />,
  /** A car: miles driven. */
  driving: (
    <>
      <path d="M2.5 11V8.5L4 5h8l1.5 3.5V11zM2.5 8.5h11" />
      <circle cx="5" cy="11.5" r="1.25" />
      <circle cx="11" cy="11.5" r="1.25" />
    </>
  ),
  /** A house: days of a home's power. */
  home: <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5M6.5 13V9.5h3V13" />,
} as const;

export type IconName = keyof typeof SHAPES;

/** The webview has no codicon font, so an agent's codicon id maps to a drawn shape, a prompt by default. */
const AGENT_ICONS: Readonly<Record<string, IconName>> = {
  sparkle: 'newSession',
  terminal: 'window',
  copilot: 'copilot',
};

/**
 * The shape for an agent. Codex gets OpenAI's logomark: its codicon is the
 * generic terminal, which VS Code needs for the terminal tab, and no codicon
 * draws OpenAI's mark.
 */
export function agentIcon(agent: Pick<AgentInfo, 'id' | 'icon'>): IconName {
  return agent.id === CODEX ? 'openai' : (AGENT_ICONS[agent.icon] ?? 'prompt');
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
