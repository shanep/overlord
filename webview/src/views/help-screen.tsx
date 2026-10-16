// The "Where things are" part of the help page: a VS Code window with
// Overlord in it, a numbered marker on every place an extension can draw
// into, and a table of Overlord's pieces with the number of the place each
// one sits in. The flow diagrams and the extending tables use the same
// numbers, so a request can say "the agent view (6)" or "add a button to 4".

import type { ReactElement } from 'react';

import type { ScreenArea } from './help-screen-content.js';
import { PIECES, SCREEN_AREAS } from './help-screen-content.js';
import {
  AgentView,
  Chrome,
  Panel,
  SecondarySidebar,
  Sidebar,
  TextEditor,
} from './help-screen-parts.js';

/** The id of the map's section, for links from elsewhere on the page. */
export const SCREEN_MAP_ID = 'help-screen';

/** A numbered marker, solid where Overlord already draws and dashed where it does not. */
export function AreaNumber(props: {
  readonly number: number;
  readonly used: boolean;
}): ReactElement {
  return (
    <span className={props.used ? 'ext-number ext-number-used' : 'ext-number'}>{props.number}</span>
  );
}

function Marker(props: { readonly area: ScreenArea }): ReactElement {
  const { area } = props;
  return (
    <g className={area.overlord === null ? 'ext-marker' : 'ext-marker ext-marker-used'}>
      <circle cx={area.at.x} cy={area.at.y} r="12" />
      <text x={area.at.x} y={area.at.y + 4.5} textAnchor="middle">
        {area.number}
      </text>
    </g>
  );
}

function ScreenDiagram(): ReactElement {
  return (
    <svg
      className="ext-diagram"
      viewBox="0 0 960 620"
      role="img"
      aria-labelledby="ext-diagram-title ext-diagram-desc"
    >
      <title id="ext-diagram-title">Overlord in a VS Code window</title>
      <desc id="ext-diagram-desc">
        A VS Code window with markers 1 to {SCREEN_AREAS.length}. The sidebar shows the Fleet,
        Global and Session Properties. The left editor group is a text file, and the right one shows
        a Claude Code tab behind the agent view. The status bar shows Overlord&apos;s counts.
      </desc>
      <rect className="ext-frame" x="0" y="0" width="960" height="620" rx="8" />
      <Sidebar />
      <TextEditor />
      <AgentView />
      <Panel />
      <SecondarySidebar />
      <Chrome />
      <rect className="ext-outline" x="0.5" y="0.5" width="959" height="619" rx="8" />
      {SCREEN_AREAS.map((area) => (
        <Marker key={area.number} area={area} />
      ))}
    </svg>
  );
}

export function ScreenSection(): ReactElement {
  return (
    <section className="section help-section" aria-labelledby={SCREEN_MAP_ID}>
      <h2 id={SCREEN_MAP_ID}>Where things are</h2>
      <p className="muted">
        Overlord in a VS Code window. Each number is a place on the screen, and the diagrams below
        put the same number on anything you can find here, so a 6 on the Agent view means the editor
        tabs. The places are the same ones listed in Extending Overlord.
      </p>
      <ScreenDiagram />
      <table className="grid help-table" aria-label="Where each piece of Overlord is">
        <thead>
          <tr>
            <th scope="col">Piece</th>
            <th scope="col" className="wrap">
              What it is
            </th>
            <th scope="col" className="wrap">
              How to get there
            </th>
          </tr>
        </thead>
        <tbody>
          {PIECES.map((piece) => (
            <tr key={piece.name}>
              <td className="help-key">
                <span className="help-pair">
                  <AreaNumber number={piece.area} used />
                  {piece.name}
                </span>
              </td>
              <td className="wrap">{piece.what}</td>
              <td className="wrap">{piece.open}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
