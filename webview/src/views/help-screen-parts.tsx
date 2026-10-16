// The pieces of the screen map: a VS Code window with Overlord in it. The
// left editor group is a plain text editor, to show what an extension can add
// to code, and the right one is Overlord's agent view. Coordinates are in the
// map's 960 by 620 grid.

import type { ReactElement } from 'react';

const CODE_LINES: readonly (readonly [y: number, indent: number, width: number])[] = [
  [80, 0, 120],
  [98, 16, 130],
  [116, 16, 90],
  [134, 32, 110],
  [152, 0, 30],
  [188, 0, 140],
  [206, 16, 100],
  [224, 16, 120],
  [242, 16, 100],
  [260, 32, 60],
  [278, 16, 80],
  [296, 0, 30],
  [332, 0, 130],
  [350, 16, 110],
  [368, 16, 90],
];

const FLEET_ROWS = ['Fix the parser', 'Help diagrams', 'Launcher run'];
const PROPERTIES: readonly (readonly [label: string, value: string])[] = [
  ['State', 'running'],
  ['Model', 'opus'],
  ['Worktree', 'overlord/2212e55b'],
];
const FEED: readonly (readonly [tool: string, width: number])[] = [
  ['Read', 120],
  ['Grep', 90],
  ['Edit', 140],
  ['Bash', 100],
  ['Edit', 70],
];
const TIMELINE: readonly (readonly [x: number, width: number, tone: string])[] = [
  [528, 40, 'ext-accent'],
  [572, 24, 'ext-state'],
  [600, 56, 'ext-accent'],
  [660, 30, 'ext-state'],
];

export function Chrome(): ReactElement {
  return (
    <>
      {/* Title bar with the Command Center */}
      <rect className="ext-chrome" x="0" y="0" width="960" height="32" />
      <circle className="ext-faint" cx="18" cy="16" r="5" />
      <circle className="ext-faint" cx="36" cy="16" r="5" />
      <circle className="ext-faint" cx="54" cy="16" r="5" />
      <rect className="ext-box" x="330" y="7" width="160" height="18" rx="5" />
      <text className="ext-muted" x="410" y="20" textAnchor="middle">
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
      {/* Status bar, with Overlord's item on the right */}
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

function FleetRow(props: { readonly title: string; readonly row: number }): ReactElement {
  const y = 108 + props.row * 22;
  const selected = props.row === 1;
  return (
    <g>
      {selected ? <rect className="ext-selected" x="48" y={y} width="240" height="22" /> : null}
      <circle className="ext-state" cx="68" cy={y + 11} r="4" />
      <text className="ext-small" x="80" y={y + 15}>
        {props.title}
      </text>
      {selected
        ? [214, 232, 250, 268].map((x) => (
            <rect
              key={x}
              className={x === 214 ? 'ext-icon ext-icon-on' : 'ext-icon'}
              x={x}
              y={y + 5}
              width="12"
              height="12"
              rx="2"
            />
          ))
        : null}
    </g>
  );
}

export function Sidebar(): ReactElement {
  return (
    <>
      <rect className="ext-side" x="48" y="32" width="240" height="560" />
      <text className="ext-heading" x="60" y="50">
        OVERLORD
      </text>
      {[196, 214, 232, 250, 268].map((x) => (
        <rect key={x} className="ext-icon" x={x} y="41" width="12" height="12" rx="2" />
      ))}
      <text className="ext-heading" x="58" y="78">
        ▾ FLEET
      </text>
      <text className="ext-small ext-strong" x="60" y="100">
        ▾ overlord
      </text>
      {FLEET_ROWS.map((title, row) => (
        <FleetRow key={title} title={title} row={row} />
      ))}
      <rect className="ext-box" x="214" y="156" width="54" height="14" rx="3" />
      <text className="ext-tiny" x="241" y="166" textAnchor="middle">
        Overlord
      </text>
      <text className="ext-heading" x="58" y="196">
        ▸ GLOBAL
      </text>
      <text className="ext-heading" x="58" y="222">
        ▾ SESSION PROPERTIES
      </text>
      {PROPERTIES.map(([label, value], row) => (
        <g key={label}>
          <text className="ext-small ext-muted" x="60" y={244 + row * 16}>
            {label}
          </text>
          <text className="ext-small" x="120" y={244 + row * 16}>
            {value}
          </text>
        </g>
      ))}
    </>
  );
}

/** The left editor group: a text file, with what an extension can add to code. */
export function TextEditor(): ReactElement {
  return (
    <>
      <rect className="ext-editor" x="288" y="32" width="228" height="360" />
      <rect className="ext-chrome" x="288" y="32" width="228" height="30" />
      <rect className="ext-editor" x="288" y="32" width="90" height="30" />
      <text x="304" y="51">
        app.ts
      </text>
      {CODE_LINES.map(([y, indent, width]) => (
        <g key={y}>
          <rect className="ext-faint" x="296" y={y} width="12" height="6" rx="1" />
          <rect className="ext-line" x={336 + indent} y={y} width={width} height="7" rx="2" />
        </g>
      ))}
      <text className="ext-muted ext-small" x="336" y="176">
        2 references | Ask Claude
      </text>
      <circle className="ext-accent" cx="322" cy="228" r="4" />
      <path
        className="ext-squiggle"
        d="M352 252q3-3 6 0t6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0"
      />
      <text className="ext-muted ext-small ext-italic" x="436" y="267">
        2 sessions
      </text>
      {/* A right click menu */}
      <rect className="ext-overlay" x="340" y="292" width="140" height="82" rx="4" />
      {['Cut', 'Copy', 'Paste'].map((item, row) => (
        <text key={item} className="ext-small" x="352" y={308 + row * 16}>
          {item}
        </text>
      ))}
      <rect className="ext-faint" x="346" y="349" width="128" height="1" />
      <rect className="ext-selected" x="344" y="353" width="132" height="18" rx="2" />
      <text className="ext-small" x="352" y="366">
        Your command
      </text>
      {/* The Command Palette, dropped down from the Command Center */}
      <rect className="ext-overlay" x="300" y="40" width="210" height="108" rx="5" />
      <rect className="ext-input" x="308" y="48" width="194" height="22" rx="2" />
      <text x="316" y="63">
        &gt; Overlord:
      </text>
      <rect className="ext-selected" x="304" y="76" width="202" height="20" rx="2" />
      {['Overlord: Fleet (full view)', 'Overlord: Launcher', 'Overlord: Help'].map((item, row) => (
        <text key={item} x="316" y={90 + row * 20}>
          {item}
        </text>
      ))}
    </>
  );
}

/** The right editor group: a Claude Code tab and Overlord's agent view, which is in front. */
export function AgentView(): ReactElement {
  return (
    <>
      <rect className="ext-editor" x="516" y="32" width="228" height="360" />
      <rect className="ext-chrome" x="516" y="32" width="228" height="30" />
      <text className="ext-muted" x="526" y="51">
        Claude Code
      </text>
      <rect className="ext-editor" x="598" y="32" width="74" height="30" />
      <rect className="ext-accent" x="598" y="32" width="74" height="2" />
      <text className="ext-strong" x="608" y="51">
        Agent view
      </text>
      {[684, 702, 720].map((x) => (
        <rect key={x} className="ext-icon" x={x} y="41" width="12" height="12" rx="2" />
      ))}
      <text className="ext-strong" x="528" y="84">
        Help diagrams
      </text>
      <text className="ext-small ext-muted" x="528" y="100">
        running, opus, $0.42
      </text>
      {FEED.map(([tool, width], row) => {
        const y = 112 + row * 22;
        return (
          <g key={y}>
            <rect className="ext-box" x="528" y={y} width="36" height="15" rx="3" />
            <text className="ext-tiny" x="546" y={y + 11} textAnchor="middle">
              {tool}
            </text>
            <rect className="ext-line" x="572" y={y + 4} width={width} height="7" rx="2" />
          </g>
        );
      })}
      <text className="ext-heading" x="528" y="246">
        TOOL TIMELINE
      </text>
      {TIMELINE.map(([x, width, tone]) => (
        <rect key={x} className={tone} x={x} y="256" width={width} height="10" rx="2" />
      ))}
      <text className="ext-heading" x="528" y="292">
        TOKENS
      </text>
      <path
        className="ext-spark"
        d="M528 370L556 360L584 364L612 340L640 344L668 318L700 322L732 304"
      />
    </>
  );
}

export function Panel(): ReactElement {
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

export function SecondarySidebar(): ReactElement {
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
