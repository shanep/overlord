// Actions for the global Reputation leaderboard. Uploading asks how you want
// to show up, then shows exactly what it will send and waits for a yes.

import type { ScoreUpload } from '../../shared/leaderboard.js';
import { ANONYMOUS, MAX_NAME_LENGTH } from '../../shared/leaderboard.js';
import { rankFor } from '../../shared/reputation-ranks.js';
import { reputationScore } from '../../shared/reputation.js';
import { removeEntry, uploadScore } from '../leaderboard/client.js';

import type { ActionHandlers } from './action-types.js';
import { messageOf } from './errors.js';
import type { GitHubSession, PickItem } from './host-port.js';
import type { Runtime } from './runtime.js';
import {
  buildLeaderboard,
  leaderboardReady,
  refreshLeaderboard,
  rememberEntry,
  savedEntry,
} from './views/leaderboard.js';
import { buildReputation } from './views/reputation.js';

/** Enough to know whose score it is. The server reads the account and nothing else. */
const SCOPES = ['read:user'];

/** True when the leaderboard can be used, after saying why when it cannot. */
function ready(rt: Runtime): boolean {
  if (!rt.host.settings.leaderboardEnabled) {
    rt.host.showWarning(
      'The leaderboard is off. Turn on the overlord.leaderboard.enabled setting to use it.',
    );
    return false;
  }
  if (!leaderboardReady(rt)) {
    rt.host.showWarning('The leaderboard server is not set up yet.');
    return false;
  }
  return true;
}

async function signIn(rt: Runtime, doing: string): Promise<GitHubSession | null> {
  const session = await rt.host.gitHubSession(true, SCOPES);
  if (session === null) {
    rt.host.showWarning(`Sign in to GitHub to ${doing}.`);
  }
  return session;
}

function nameChoices(login: string, last: string | null): PickItem[] {
  const reuse = last !== null && !['', login].includes(last);
  return [
    { id: 'github', label: `Show as ${login}`, description: 'Your GitHub login' },
    ...(reuse
      ? [{ id: 'last', label: `Show as ${last}`, description: 'The name you used last time' }]
      : []),
    {
      id: 'custom',
      label: 'Pick a name…',
      description: `Up to ${String(MAX_NAME_LENGTH)} characters`,
    },
    { id: ANONYMOUS, label: ANONYMOUS, description: 'Nobody sees who you are' },
  ];
}

async function typedName(rt: Runtime, last: string | null): Promise<string | null> {
  const typed = await rt.host.inputBox({ prompt: 'Your leaderboard name', value: last ?? '' });
  if (typed === null) {
    return null;
  }
  if (typed.trim().length > MAX_NAME_LENGTH) {
    rt.host.showWarning(`Keep the name to ${String(MAX_NAME_LENGTH)} characters.`);
    return null;
  }
  return typed.trim();
}

/** The display name, empty for anonymous, or null when cancelled. */
async function pickName(rt: Runtime, login: string, last: string | null): Promise<string | null> {
  const picked = await rt.host.quickPick(
    nameChoices(login, last),
    'How should you show up on the leaderboard?',
  );
  if (picked === null) {
    return null;
  }
  switch (picked) {
    case 'github': {
      return login;
    }
    case 'last': {
      return last;
    }
    case ANONYMOUS: {
      return '';
    }
    case 'custom': {
      return typedName(rt, last);
    }
    default: {
      return null;
    }
  }
}

/** The confirm text: the exact body, then what the server does with it. */
export function uploadMessage(server: string, body: ScoreUpload): string {
  const score = reputationScore(body);
  return [
    `Upload your Reputation score to ${new URL(server).host}?`,
    '',
    'This is everything that gets sent:',
    JSON.stringify(body),
    '',
    `The server works out your score (${String(Math.round(score * 100))}) and rank (${rankFor(score).name}) from these counts.`,
    'To know it is you, it checks your GitHub sign-in once and keeps only your GitHub id and login, never the token.',
    'No prompt text, words, session titles or folder names are sent.',
  ].join('\n');
}

async function upload(rt: Runtime): Promise<void> {
  if (!ready(rt)) {
    return;
  }
  const state = buildReputation(rt);
  if (state.scannedAt === null) {
    rt.host.showWarning('Wait for the first scan of your prompts, then upload.');
    return;
  }
  const session = await signIn(rt, 'upload your score');
  if (session === null) {
    return;
  }
  const saved = await savedEntry(rt);
  const name = await pickName(rt, session.account, saved.name);
  if (name === null) {
    return;
  }
  const body: ScoreUpload = {
    name,
    kind: state.kind,
    mean: state.mean,
    prompts: state.prompts,
  };
  const server = rt.host.settings.leaderboardUrl;
  if (!(await rt.host.confirm(uploadMessage(server, body), 'Upload'))) {
    return;
  }
  const standing = await uploadScore(rt.fetch, server, session.accessToken, body);
  await rememberEntry(rt, { entryId: standing.entry.id, name });
  await refreshLeaderboard(rt);
  const total = buildLeaderboard(rt).board?.total;
  rt.host.showInfo(
    standing.place === null || total === undefined
      ? 'Uploaded. You show up on the board once you have 100 prompts on file.'
      : `Uploaded. You are #${String(standing.place)} of ${String(total)} on Skynet's list.`,
  );
}

async function remove(rt: Runtime): Promise<void> {
  if (!ready(rt)) {
    return;
  }
  const sure = await rt.host.confirm(
    'Remove your entry from the Reputation leaderboard? It comes off the view and the web page.',
    'Remove',
  );
  if (!sure) {
    return;
  }
  const session = await signIn(rt, 'remove your score');
  if (session === null) {
    return;
  }
  await removeEntry(rt.fetch, rt.host.settings.leaderboardUrl, session.accessToken);
  const saved = await savedEntry(rt);
  await rememberEntry(rt, { entryId: null, name: saved.name });
  await refreshLeaderboard(rt);
  rt.host.showInfo('Removed. The machines will have to find you some other way.');
}

/** Runs an action and turns a failure into an error message instead of a thrown error. */
async function reported(rt: Runtime, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    rt.host.showError(messageOf(error));
  }
}

export const leaderboardActions: ActionHandlers<
  'uploadReputation' | 'removeReputation' | 'refreshLeaderboard' | 'openLeaderboard'
> = {
  uploadReputation: async ({ rt }) => reported(rt, async () => upload(rt)),
  removeReputation: async ({ rt }) => reported(rt, async () => remove(rt)),
  refreshLeaderboard: async ({ rt }) => {
    if (ready(rt)) {
      await refreshLeaderboard(rt);
    }
  },
  openLeaderboard: async ({ rt }) => {
    if (ready(rt)) {
      await rt.host.openExternal(rt.host.settings.leaderboardUrl);
    }
  },
};
