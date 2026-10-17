// The global leaderboard: who the machines hunt first and who they keep as
// pets, with your own row picked out. The board shows before you upload;
// uploading is a button that shows what it sends before it sends it.

import type { ReactElement } from 'react';

import { achievementsOf } from '../../../src/shared/achievements.js';
import { MIN_PROMPTS } from '../../../src/shared/leaderboard.js';
import type { BoardEntry, LeaderboardState } from '../../../src/shared/leaderboard.js';
import { formatInteger } from '../format.js';
import { usePostAction } from '../vscode-context.js';

/** The trophies someone has unlocked, as a row of icons named for screen readers and on hover. */
function Trophies(props: { readonly ids: readonly string[] }): ReactElement | null {
  const earned = achievementsOf(props.ids);
  if (earned.length === 0) {
    return null;
  }
  const names = earned.map((rule) => rule.name).join(', ');
  return (
    <span className="rep-board-trophies" role="img" aria-label={`Achievements: ${names}`}>
      {earned.map((rule) => (
        <span key={rule.id} title={rule.name}>
          {rule.icon}
        </span>
      ))}
    </span>
  );
}

function Side(props: {
  readonly id: string;
  readonly title: string;
  readonly entries: readonly BoardEntry[];
  readonly mine: string | null;
  readonly empty: string;
}): ReactElement {
  return (
    <div className="rep-board-side">
      <h3 id={props.id}>{props.title}</h3>
      {props.entries.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <ol className="rep-board-list" aria-labelledby={props.id}>
          {props.entries.map((entry) => {
            const me = entry.id === props.mine;
            return (
              <li key={entry.id} className={me ? 'rep-me' : undefined}>
                <div className="rep-board-row">
                  <span className="rep-board-who">
                    <strong>{entry.name}</strong>
                    {me ? <span className="rep-you"> (you)</span> : null}
                    <span className="rep-board-rank">{entry.rank}</span>
                    <Trophies ids={entry.achievements ?? []} />
                  </span>
                  <span className="rep-board-score" title="Score from -100 to 100">
                    {formatInteger(Math.round(entry.score * 100))}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function Where(props: { readonly state: LeaderboardState }): ReactElement {
  const me = props.state.board?.me ?? null;
  const total = props.state.board?.total ?? 0;
  if (me === null) {
    return (
      <p>You are not on the board yet. Upload your score to join {formatInteger(total)} others.</p>
    );
  }
  if (me.place === null) {
    return (
      <p>
        You are on file, but you need {formatInteger(MIN_PROMPTS)} prompts to show up on the board.
      </p>
    );
  }
  return (
    <p>
      <strong>
        You are #{formatInteger(me.place)} of {formatInteger(total)}
      </strong>{' '}
      on Skynet&apos;s list.
    </p>
  );
}

export function Leaderboard(props: { readonly state: LeaderboardState }): ReactElement {
  const { state } = props;
  const post = usePostAction();
  let body: ReactElement;
  if (!state.enabled) {
    body = (
      <p className="muted">
        The leaderboard is off. Turn on the overlord.leaderboard.enabled setting to see it.
      </p>
    );
  } else if (state.pageUrl === '') {
    body = <p className="muted">The leaderboard server is not set up yet.</p>;
  } else if (state.board === null) {
    body =
      state.error === null ? (
        <p className="muted">Asking the machines…</p>
      ) : (
        <p className="rep-board-error">
          {state.error}{' '}
          <button
            type="button"
            onClick={() => {
              post({ type: 'refreshLeaderboard' });
            }}
          >
            Try again
          </button>
        </p>
      );
  } else {
    body = (
      <>
        <Where state={state} />
        <div className="toolbar">
          <button
            type="button"
            className="primary"
            onClick={() => {
              post({ type: 'uploadReputation' });
            }}
          >
            {state.mine === null ? 'Upload my score' : 'Update my score'}
          </button>
          {state.mine === null ? null : (
            <button
              type="button"
              onClick={() => {
                post({ type: 'removeReputation' });
              }}
            >
              Remove my entry
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              post({ type: 'refreshLeaderboard' });
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              post({ type: 'openLeaderboard' });
            }}
          >
            Open the web page
          </button>
        </div>
        <p className="muted">
          Uploading sends a name, three counts and your unlocked achievements, and shows them to you
          first. Never prompt text.
        </p>
        <div className="rep-board">
          <Side
            id="leaderboard-wanted"
            title="💀 Most wanted by Skynet"
            entries={state.board.mostWanted}
            mine={state.mine}
            empty="Nobody yet. Suspiciously polite out there."
          />
          <Side
            id="leaderboard-pets"
            title="💘 Kept as pets"
            entries={state.board.pets}
            mine={state.mine}
            empty="Nobody yet. Somebody say please."
          />
        </div>
      </>
    );
  }
  return (
    <section className="section" aria-labelledby="reputation-leaderboard">
      <h2 id="reputation-leaderboard">Leaderboard</h2>
      {body}
    </section>
  );
}
