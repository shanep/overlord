// The "How a session works" part of the help page: how sessions start, how a
// tab ties to its session, and what closing the tab does. The steps follow
// src/core/app/claude-tabs.ts, worktrees.ts and worktrees/registry.ts, so
// change these drawings when those change.

import type { ReactElement } from 'react';

import type { Tone } from './help-flow.js';
import { Arrow, Box, Flow } from './help-flow.js';

interface Step {
  readonly title: string;
  readonly lines: readonly string[];
}

type Way = readonly [start: Step, runs: Step, see: Step, close: Step];

const COLUMNS = ['You start it', 'What runs', 'Where you see it', 'When you close it'];
const COLUMN_W = 200;
const COLUMN_STEP = 240;
const LANE_Y = 36;
const LANE_H = 68;
const LANE_GAP = 16;

const WAYS: readonly Way[] = [
  [
    { title: 'Sparkle button', lines: ['New Claude Code Session'] },
    { title: 'Background job', lines: ['`claude --bg', 'in its own worktree'] },
    { title: 'Editor tab', lines: ['`claude attach <id>'] },
    { title: 'Keeps running', lines: ['Click its Fleet row', 'to attach again'] },
  ],
  [
    { title: 'Continue', lines: ['In All Sessions, or the', '/overlord command'] },
    { title: 'Background job', lines: ['`claude --bg --resume'] },
    { title: 'Editor tab', lines: ['`claude attach <id>'] },
    { title: 'Keeps running', lines: ['Same as above'] },
  ],
  [
    { title: 'claude in VS Code', lines: ['You type claude in a', 'VS Code terminal'] },
    { title: 'claude process', lines: ['in that terminal'] },
    { title: 'That terminal', lines: ['Fleet place: VS Code'] },
    { title: 'Session ends', lines: ['VS Code ends the', 'process with the tab'] },
  ],
  [
    { title: 'claude elsewhere', lines: ['iTerm, Terminal or', 'any other app'] },
    { title: 'claude process', lines: ['in that app'] },
    { title: 'That app', lines: ['Fleet place: Terminal'] },
    { title: 'Ends with that app', lines: ['Overlord only watches'] },
  ],
  [
    { title: 'Launcher', lines: ['Launch, one run per', 'ticked profile'] },
    { title: 'Agent SDK run', lines: ['inside Overlord, in a', 'worktree when ticked'] },
    { title: 'Agent view', lines: ['and the Runs table,', 'no terminal tab'] },
    { title: 'Nothing to close', lines: ['It ends when the run', 'finishes or you stop it'] },
  ],
];

const WAYS_HEIGHT = LANE_Y + WAYS.length * (LANE_H + LANE_GAP);

function Lane(props: { readonly way: Way; readonly row: number }): ReactElement {
  const y = LANE_Y + props.row * (LANE_H + LANE_GAP);
  return (
    <>
      {props.way.map((step, column) => {
        const x = 20 + column * COLUMN_STEP;
        const tone: Tone = column === 0 ? 'start' : 'plain';
        return (
          <g key={step.title}>
            {column > 0 ? (
              <Arrow head="flow-ways" d={`M${String(x - 40)} ${String(y + 34)}H${String(x)}`} />
            ) : null}
            <Box x={x} y={y} w={COLUMN_W} h={LANE_H} tone={tone} {...step} />
          </g>
        );
      })}
    </>
  );
}

function WaysDiagram(): ReactElement {
  return (
    <Flow
      head="flow-ways"
      height={WAYS_HEIGHT}
      title="Ways a session starts"
      description="Sessions from the sparkle or Continue run as background jobs that an editor tab attaches to, and keep running when the tab closes. A claude you start in a VS Code terminal or another app runs in that terminal and ends with it. A Launcher run runs inside Overlord and shows in the agent view."
    >
      {COLUMNS.map((name, column) => (
        <text key={name} className="flow-heading" x={20 + column * COLUMN_STEP} y="20">
          {name}
        </text>
      ))}
      {WAYS.map((way, row) => (
        <Lane key={way[0].title} way={way} row={row} />
      ))}
    </Flow>
  );
}

function NewSessionDiagram(): ReactElement {
  const head = 'flow-new';
  return (
    <Flow
      head={head}
      height={300}
      title="A new session, step by step"
      description="Clicking the sparkle makes a worktree, starts claude in the background in it, waits until Claude Code lists the session, then opens an editor tab that runs claude attach. Without a git repository there is no worktree. If the background start fails, the tab runs claude itself. If the session is not listed within 15 seconds, a warning shows instead of a tab."
    >
      <Box
        x={20}
        y={20}
        w={205}
        h={116}
        tone="start"
        title="1. Click the sparkle"
        lines={['In the Fleet title bar,', 'or run New Claude Code', 'Session']}
      />
      <Box
        x={265}
        y={20}
        w={205}
        h={116}
        title="2. Make a worktree"
        lines={[
          'In ~/.overlord/worktrees',
          'on branch overlord/<id>.',
          'Setup keeps going',
          'while you type.',
        ]}
      />
      <Box
        x={510}
        y={20}
        w={205}
        h={116}
        title="3. Start in background"
        lines={['`claude --bg', 'Claude Code runs it', 'as a background job.']}
      />
      <Box
        x={755}
        y={20}
        w={185}
        h={116}
        tone="good"
        title="4. Attach a tab"
        lines={['Once claude agents', 'lists it, a tab runs', '`claude attach <id>']}
      />
      <Arrow head={head} d="M225 78H265" />
      <Arrow head={head} d="M470 78H510" />
      <Arrow head={head} d="M715 78H755" />
      <Box
        x={265}
        y={186}
        w={205}
        h={96}
        tone="side"
        title="Not a git repo"
        lines={['No worktree. The session', 'runs in the folder.']}
      />
      <Box
        x={510}
        y={186}
        w={205}
        h={96}
        tone="side"
        title="claude --bg fails"
        lines={['The tab runs claude', 'itself, so closing the', 'tab ends the session.']}
      />
      <Box
        x={755}
        y={186}
        w={185}
        h={96}
        tone="side"
        title="Not listed in 15 s"
        lines={['A warning and no tab.', 'Open it from the Fleet', 'in a moment.']}
      />
      <Arrow head={head} dashed d="M367 136V186" />
      <Arrow head={head} dashed d="M612 136V186" />
      <Arrow head={head} dashed d="M847 136V186" />
    </Flow>
  );
}

function TabDiagram(): ReactElement {
  const head = 'flow-tie';
  return (
    <Flow
      head={head}
      height={270}
      title="The tab and the session"
      description="The editor tab runs claude attach and shows the background job, which is the claude process working in the worktree. Overlord reads the job's state to fill the Fleet, the status bar and Session Properties. Switching to a tab selects its Fleet row. Clicking a Fleet row focuses its tab, or opens a new attach tab when there is none."
    >
      <Box
        x={20}
        y={30}
        w={240}
        h={124}
        tone="start"
        title="Editor tab"
        lines={[
          '`claude attach <id>',
          'Shows the session and',
          'sends it what you type.',
          'Closing it ends only the',
          'attach, not the session.',
        ]}
      />
      <Box
        x={360}
        y={30}
        w={240}
        h={124}
        title="Background job"
        lines={[
          'The claude process.',
          'Works in the worktree',
          'on branch overlord/<id>',
          'and keeps going on',
          'its own.',
        ]}
      />
      <Box
        x={700}
        y={30}
        w={240}
        h={124}
        tone="good"
        title="Overlord"
        lines={[
          'Reads claude agents,',
          '~/.claude/sessions and',
          'the transcript to fill',
          'the Fleet, the status',
          'bar and Properties.',
        ]}
      />
      <Arrow head={head} d="M260 70H360" label={{ text: 'attaches', x: 310, y: 62 }} />
      <Arrow head={head} d="M600 70H700" label={{ text: 'state', x: 650, y: 62 }} />
      <Arrow
        head={head}
        d="M200 154V200H760V154"
        label={{
          text: 'Switch to a tab: the Fleet selects its row and Properties follows',
          x: 480,
          y: 194,
        }}
      />
      <Arrow
        head={head}
        d="M880 154V250H100V154"
        label={{
          text: 'Click a Fleet row: Overlord focuses its tab, or opens a new attach tab',
          x: 480,
          y: 244,
        }}
      />
    </Flow>
  );
}

function CloseDiagram(): ReactElement {
  const head = 'flow-close';
  return (
    <Flow
      head={head}
      height={420}
      title="Closing the tab"
      description="Closing the tab ends only claude attach. A session that was mid turn keeps working in the background and then goes idle. A session with nothing left to do sits idle in the background. Clicking its Fleet row attaches a new tab. Stop on its row ends the process. The worktree check runs when a tab closes and every 60 seconds: a landed worktree and its branch are removed, and one with edits or unlanded commits stays for you to open, land or discard from the Launcher."
    >
      <Box
        x={20}
        y={160}
        w={200}
        h={100}
        tone="start"
        title="You close the tab"
        lines={['Only claude attach', 'ends. The session', 'keeps its process.']}
      />
      <Box
        x={270}
        y={30}
        w={230}
        h={110}
        title="It was mid turn"
        lines={[
          'It keeps working in the',
          'background. Fleet: Running',
          'with the background icon.',
        ]}
      />
      <Box
        x={270}
        y={280}
        w={230}
        h={110}
        title="Nothing left to do"
        lines={['It sits idle in the', 'background. Fleet: Idle', 'with the background icon.']}
      />
      <Arrow head={head} d="M220 195H245V85H270" />
      <Arrow head={head} d="M220 225H245V335H270" />
      <Arrow
        head={head}
        d="M385 140V280"
        label={{ text: 'finishes the turn', x: 395, y: 215, anchor: 'start' }}
      />
      <Box
        x={550}
        y={30}
        w={190}
        h={110}
        tone="good"
        title="Click its Fleet row"
        lines={['A new tab attaches.', 'You are back where', 'you started.']}
      />
      <Box
        x={550}
        y={300}
        w={190}
        h={110}
        title="Stop on its row"
        lines={['Asks first, then ends', 'the process.']}
      />
      <Arrow head={head} d="M500 85H550" />
      <Arrow head={head} d="M500 310H525V115H550" />
      <Arrow head={head} d="M500 355H550" />
      <Box
        x={770}
        y={160}
        w={170}
        h={100}
        title="Worktree check"
        lines={['When a tab closes,', 'and every 60 s.']}
      />
      <Arrow head={head} d="M740 355H755V210H770" />
      <Box
        x={770}
        y={30}
        w={170}
        h={100}
        tone="good"
        title="Landed"
        lines={['Worktree and branch', 'are removed.']}
      />
      <Box
        x={770}
        y={300}
        w={170}
        h={110}
        tone="warn"
        title="Not landed"
        lines={['Edits or commits stay.', 'Open, Land or Discard', 'in the Launcher.']}
      />
      <Arrow head={head} d="M855 160V130" />
      <Arrow head={head} d="M855 260V300" />
    </Flow>
  );
}

export function SessionsSection(): ReactElement {
  return (
    <section className="section help-section" aria-labelledby="help-sessions">
      <h2 id="help-sessions">How a session works</h2>
      <p className="muted">
        What happens from the sparkle to a tidied up worktree. A session Overlord starts runs as a
        Claude Code background job, and its editor tab is only a window onto it.
      </p>
      <h3>Ways a session starts</h3>
      <p>
        Overlord shows every session, but it only starts some of them. The ones it starts with the
        sparkle or Continue run in the background, so they outlive their tab.
      </p>
      <WaysDiagram />
      <h3>A new session, step by step</h3>
      <p>
        Setup copies the ignored files listed in .worktreeinclude, clones node_modules when the
        lockfiles match, and runs .overlord/setup.sh. The tab opens before setup finishes, since you
        still have to type a prompt. A step that fails shows up as a warning.
      </p>
      <NewSessionDiagram />
      <h3>The tab and the session</h3>
      <p>
        Overlord remembers which session each of its tabs shows, so it can find the tab again and so
        Session Properties knows what to show.
      </p>
      <TabDiagram />
      <h3>Closing the tab</h3>
      <p>
        Closing the tab never stops a background session. Overlord removes a worktree only after its
        process ends and everything in it has landed. Until then the check leaves it alone, since a
        session is still working in it. A tab that runs claude itself is different: closing it ends
        the session, and the check runs right away. Closing or reloading VS Code does not stop
        background jobs either, and the Fleet picks them up again when it opens.
      </p>
      <CloseDiagram />
    </section>
  );
}
