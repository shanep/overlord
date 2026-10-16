// The "Extending Overlord" part of the help page: a drawing of a VS Code
// window with a numbered marker on every place an extension can draw into, and
// a table that says what goes in each one. The numbers give us a shared name
// for each place, so a request can say "add a button to 4".

import type { ReactElement } from 'react';

import type { ExtensionPoint, ScreenArea } from './help-content.js';
import { OFF_SCREEN, SCREEN_AREAS } from './help-content.js';

const FLEET_ROWS = [120, 96, 140, 84, 112, 128];
const CODE_LINES: readonly (readonly [y: number, indent: number, width: number])[] = [
  [80, 0, 180],
  [98, 16, 220],
  [116, 16, 150],
  [134, 32, 260],
  [152, 0, 40],
  [188, 0, 200],
  [206, 16, 170],
  [224, 16, 240],
  [242, 32, 110],
  [260, 32, 120],
  [278, 16, 90],
  [296, 0, 40],
  [314, 0, 0],
  [332, 0, 230],
  [350, 16, 190],
  [368, 16, 140],
];

function usedBy(area: ExtensionPoint): string {
  return area.overlord ?? 'Not yet.';
}

/** A numbered marker, solid where Overlord already draws and dashed where it does not. */
function AreaNumber(props: { readonly area: ScreenArea }): ReactElement {
  const used = props.area.overlord !== null;
  return (
    <span className={used ? 'ext-number ext-number-used' : 'ext-number'}>{props.area.number}</span>
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

function Chrome(): ReactElement {
  return (
    <>
      {/* Title bar with the Command Center */}
      <rect className="ext-chrome" x="0" y="0" width="960" height="32" />
      <circle className="ext-faint" cx="18" cy="16" r="5" />
      <circle className="ext-faint" cx="36" cy="16" r="5" />
      <circle className="ext-faint" cx="54" cy="16" r="5" />
      <rect className="ext-box" x="360" y="7" width="240" height="18" rx="5" />
      <text className="ext-muted" x="480" y="20" textAnchor="middle">
        overlord
      </text>
      {/* Activity bar, with the Overlord icon selected and badged */}
      <rect className="ext-chrome" x="0" y="32" width="48" height="560" />
      {[46, 86, 126, 166].map((y) => (
        <rect
          key={y}
          className={y === 166 ? 'ext-icon ext-icon-on' : 'ext-icon'}
          x="13"
          y={y}
          width="22"
          height="22"
          rx="4"
        />
      ))}
      <rect className="ext-accent" x="0" y="164" width="2" height="26" />
      <circle className="ext-badge" cx="36" cy="186" r="7" />
      <text className="ext-badge-text" x="36" y="189.5" textAnchor="middle">
        2
      </text>
      {/* Status bar */}
      <rect className="ext-status" x="0" y="592" width="960" height="28" />
      <text className="ext-status-text" x="12" y="610">
        master
      </text>
      <rect className="ext-status-item" x="648" y="595" width="180" height="22" rx="2" />
      <text className="ext-status-text" x="656" y="610">
        3 running, 1 waiting, $4.20/h
      </text>
      <text className="ext-status-text" x="846" y="610">
        Ln 12, Col 4
      </text>
    </>
  );
}

function Sidebar(): ReactElement {
  return (
    <>
      <rect className="ext-side" x="48" y="32" width="240" height="560" />
      <text className="ext-heading" x="60" y="50">
        OVERLORD
      </text>
      {[196, 214, 232, 250, 268].map((x) => (
        <rect key={x} className="ext-icon" x={x} y="41" width="12" height="12" rx="2" />
      ))}
      <text className="ext-heading" x="58" y="80">
        ▾ FLEET
      </text>
      <rect className="ext-selected" x="48" y="114" width="240" height="22" />
      {FLEET_ROWS.map((width, row) => {
        const y = 92 + row * 22;
        return (
          <g key={y}>
            <circle className="ext-state" cx="68" cy={y + 11} r="4" />
            <rect className="ext-line" x="80" y={y + 7} width={width} height="7" rx="2" />
          </g>
        );
      })}
      {['▸ GLOBAL', '▸ SESSIONS AND AGENTS', '▸ SESSION PROPERTIES'].map((label, row) => (
        <text key={label} className="ext-heading" x="58" y={250 + row * 22}>
          {label}
        </text>
      ))}
    </>
  );
}

function Editor(): ReactElement {
  return (
    <>
      <rect className="ext-editor" x="288" y="32" width="456" height="360" />
      <rect className="ext-chrome" x="288" y="32" width="456" height="30" />
      <rect className="ext-editor" x="288" y="32" width="110" height="30" />
      <text x="304" y="51">
        app.ts
      </text>
      <text className="ext-muted" x="412" y="51">
        Claude Code
      </text>
      {[690, 708, 726].map((x) => (
        <rect key={x} className="ext-icon" x={x} y="41" width="12" height="12" rx="2" />
      ))}
      {CODE_LINES.map(([y, indent, width]) => (
        <g key={y}>
          <rect className="ext-faint" x="296" y={y} width="12" height="6" rx="1" />
          <rect className="ext-line" x={336 + indent} y={y} width={width} height="7" rx="2" />
        </g>
      ))}
      {/* Things an extension can add inside a text editor */}
      <text className="ext-muted ext-small" x="336" y="176">
        2 references | Ask Claude
      </text>
      <circle className="ext-accent" cx="322" cy="228" r="4" />
      <path
        className="ext-squiggle"
        d="M368 252q3-3 6 0t6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0"
      />
      <text className="ext-muted ext-small ext-italic" x="500" y="267">
        edited by 2 sessions
      </text>
      {/* A right click menu */}
      <rect className="ext-overlay" x="360" y="292" width="150" height="82" rx="4" />
      {['Cut', 'Copy', 'Paste'].map((item, row) => (
        <text key={item} className="ext-small" x="372" y={308 + row * 16}>
          {item}
        </text>
      ))}
      <rect className="ext-faint" x="366" y="349" width="138" height="1" />
      <rect className="ext-selected" x="364" y="353" width="142" height="18" rx="2" />
      <text className="ext-small" x="372" y="366">
        Your command
      </text>
      {/* The Command Palette, dropped down over the tabs */}
      <rect className="ext-overlay" x="400" y="40" width="240" height="108" rx="5" />
      <rect className="ext-input" x="408" y="48" width="224" height="22" rx="2" />
      <text x="416" y="63">
        &gt; Overlord:
      </text>
      <rect className="ext-selected" x="404" y="76" width="232" height="20" rx="2" />
      {['Overlord: Fleet (full view)', 'Overlord: Launcher', 'Overlord: Help'].map((item, row) => (
        <text key={item} x="416" y={90 + row * 20}>
          {item}
        </text>
      ))}
    </>
  );
}

function Panel(): ReactElement {
  return (
    <>
      <rect className="ext-editor" x="288" y="392" width="456" height="200" />
      <text className="ext-heading ext-muted" x="300" y="412">
        PROBLEMS
      </text>
      <text className="ext-heading ext-muted" x="370" y="412">
        OUTPUT
      </text>
      <text className="ext-heading" x="430" y="412">
        TERMINAL
      </text>
      <rect className="ext-accent" x="430" y="418" width="56" height="2" />
      <text className="ext-mono" x="300" y="444">
        $ claude
      </text>
      {[120, 260, 180, 220].map((width, row) => (
        <rect
          key={row}
          className="ext-line"
          x="300"
          y={456 + row * 16}
          width={width}
          height="7"
          rx="2"
        />
      ))}
    </>
  );
}

function SecondarySidebar(): ReactElement {
  return (
    <>
      <rect className="ext-side" x="744" y="32" width="216" height="560" />
      <text className="ext-heading" x="756" y="50">
        CHAT
      </text>
      <rect className="ext-box" x="790" y="66" width="158" height="38" rx="6" />
      <rect className="ext-line" x="800" y="76" width="120" height="7" rx="2" />
      <rect className="ext-line" x="800" y="90" width="80" height="7" rx="2" />
      {[124, 140, 156, 172].map((y, row) => (
        <rect key={y} className="ext-line" x="756" y={y} width={180 - row * 24} height="7" rx="2" />
      ))}
      <rect className="ext-input" x="756" y="440" width="192" height="32" rx="4" />
      <text className="ext-muted" x="766" y="460">
        @participant ask...
      </text>
      {/* A notification toast in the corner */}
      <rect className="ext-overlay" x="754" y="510" width="198" height="72" rx="5" />
      <circle className="ext-accent" cx="772" cy="530" r="6" />
      <text x="786" y="534">
        Starting Claude Code
      </text>
      <rect className="ext-faint" x="768" y="560" width="170" height="3" />
      <rect className="ext-accent" x="768" y="560" width="80" height="3" />
    </>
  );
}

/** A VS Code window with every extensible place numbered. */
function ScreenDiagram(): ReactElement {
  return (
    <svg
      className="ext-diagram"
      viewBox="0 0 960 620"
      role="img"
      aria-labelledby="ext-diagram-title ext-diagram-desc"
    >
      <title id="ext-diagram-title">Places in VS Code an extension can draw into</title>
      <desc id="ext-diagram-desc">
        A VS Code window with markers 1 to {SCREEN_AREAS.length}, one per row of the table below.
      </desc>
      <rect className="ext-frame" x="0" y="0" width="960" height="620" rx="8" />
      <Sidebar />
      <Editor />
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

export function ExtendSection(): ReactElement {
  return (
    <section className="section help-section" aria-labelledby="help-extend">
      <h2 id="help-extend">Extending Overlord</h2>
      <p className="muted">
        Every place on the VS Code screen an extension can draw into. Ask for a change by number,
        like &quot;add a button to 4&quot; or &quot;show the cost in 12&quot;. A solid marker is a
        place Overlord already uses, and a dashed one is still open. The places come from{' '}
        <code>contributes</code> in package.json and from the code in src/host.
      </p>
      <ScreenDiagram />
      <table className="grid help-table" aria-label="Places an extension can draw into">
        <thead>
          <tr>
            <th scope="col">Area</th>
            <th scope="col" className="wrap">
              What an extension can put there
            </th>
            <th scope="col" className="wrap">
              In Overlord
            </th>
          </tr>
        </thead>
        <tbody>
          {SCREEN_AREAS.map((area) => (
            <tr key={area.number}>
              <td className="help-key">
                <span className="help-pair">
                  <AreaNumber area={area} />
                  {area.name}
                </span>
              </td>
              <td className="wrap">{area.apis}</td>
              <td className="wrap">{usedBy(area)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Off the screen</h3>
      <p className="muted">These change VS Code without a place of their own.</p>
      <table className="grid help-table" aria-label="Extension points off the screen">
        <thead>
          <tr>
            <th scope="col">Point</th>
            <th scope="col" className="wrap">
              What it does
            </th>
            <th scope="col" className="wrap">
              In Overlord
            </th>
          </tr>
        </thead>
        <tbody>
          {OFF_SCREEN.map((point) => (
            <tr key={point.name}>
              <td className="help-key">{point.name}</td>
              <td className="wrap">{point.apis}</td>
              <td className="wrap">{usedBy(point)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
