import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { userPrompt } from '../transcripts/test-helpers/fixtures.js';

import { Sources } from './sources.js';
import { makeApp, makeEnv, shortSocketPath, waitFor, writeText } from './test-helpers/fixtures.js';

describe('Sources', () => {
  it('uses fs.watch for transcripts when no watch factory is given', async () => {
    const env = await makeEnv();
    await writeText(path.join(env.paths.projectsDir, '-w', 'first.jsonl'), '');
    const { app } = makeApp(env, { deps: { clock: () => Date.now() } });
    const rt = app.runtime;
    const sources = new Sources({
      paths: rt.paths,
      host: rt.host,
      bus: rt.bus,
      clock: rt.clock,
      platform: rt.platform,
      socketPath: shortSocketPath(),
      watchFactory: undefined,
      permissions: rt.permissions,
      context: rt.context,
      report: rt.report,
      notify: rt.notify,
    });
    await sources.startWatcher();
    const line = JSON.stringify({ ...userPrompt('u1', 0, 'hello'), sessionId: 'second' });
    await writeText(path.join(env.paths.projectsDir, '-w', 'second.jsonl'), `${line}\n`);
    await waitFor(() =>
      rt.store.fleetState(Date.now()).sessions.some((item) => item.id === 'second'),
    );
    expect(sources.observerMode).toBe(false);
    expect(sources.telemetryPort).toBeNull();
    await sources.stop();
    await sources.sync();
    await sources.refreshWatcher();
  });
});
