import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { LaunchProfile } from '../../../src/shared/model.js';
import { knobsState } from '../../test/fixtures-context.js';
import { expectAccessible, FakeApi, renderView } from '../../test/render.js';
import { VsCodeProvider } from '../vscode-context.js';

import { blankProfile, fromDraft, ProfilesEditor, toDraft } from './knobs-profiles.js';
import { FeatureFlags } from './knobs-view.js';

const [fast, deep] = knobsState.profiles;

function fastProfile(): LaunchProfile {
  if (fast === undefined) {
    throw new Error('fixture profile missing');
  }
  return fast;
}

function form(name: string): HTMLElement {
  return screen.getByRole('group', { name });
}

describe('profile drafts', () => {
  it('round trips a profile through the editor fields', () => {
    const profile = fastProfile();
    const draft = toDraft(profile);
    expect(draft).toStrictEqual({
      name: 'Fast',
      model: 'claude-sonnet-4-6',
      effort: 'low',
      mode: 'acceptEdits',
      env: 'BASH_MAX_OUTPUT_LENGTH=10000',
      args: '--verbose',
    });
    expect(fromDraft(profile.id, draft)).toStrictEqual(profile);
  });

  it('maps empty fields to null and an unknown mode to none', () => {
    const blank = blankProfile('p9');
    expect(toDraft(blank)).toStrictEqual({
      name: '',
      model: '',
      effort: '',
      mode: '',
      env: '',
      args: '',
    });
    expect(fromDraft('p9', { ...toDraft(blank), name: ' New ', mode: 'nope' })).toStrictEqual({
      ...blank,
      name: 'New',
    });
  });
});

describe('ProfilesEditor', () => {
  it('edits and saves an existing profile', async () => {
    const { api, container } = renderView(<ProfilesEditor profiles={knobsState.profiles} />);
    await expectAccessible(container);
    const fastForm = within(form('Fast'));
    const name = fastForm.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Quick');
    await userEvent.clear(fastForm.getByRole('textbox', { name: 'Effort' }));
    await userEvent.type(fastForm.getByRole('textbox', { name: 'Extra args' }), ' --debug');
    await userEvent.selectOptions(
      fastForm.getByRole('combobox', { name: 'Permission mode' }),
      'plan',
    );
    const env = fastForm.getByRole('textbox', { name: 'Env vars, one KEY=VALUE per line' });
    await userEvent.type(env, '\nDEBUG=1');
    await userEvent.click(fastForm.getByRole('button', { name: 'Save profile' }));
    expect(api.actions()).toStrictEqual([
      {
        type: 'saveProfile',
        profile: {
          id: 'p1',
          name: 'Quick',
          model: 'claude-sonnet-4-6',
          effort: null,
          permissionMode: 'plan',
          env: { BASH_MAX_OUTPUT_LENGTH: '10000', DEBUG: '1' },
          extraArgs: ['--verbose', '--debug'],
        },
      },
    ]);
  });

  it('saves a profile with no permission mode as null', async () => {
    const { api } = renderView(<ProfilesEditor profiles={knobsState.profiles} />);
    const deepForm = within(form('Deep'));
    expect(deepForm.getByRole('combobox', { name: 'Permission mode' })).toHaveProperty('value', '');
    await userEvent.click(deepForm.getByRole('button', { name: 'Save profile' }));
    expect(api.actions()).toStrictEqual([{ type: 'saveProfile', profile: deep }]);
  });

  it('adds a blank profile that saves once it has a name', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { api } = renderView(<ProfilesEditor profiles={[]} />);
    expect(screen.getByText('No profiles yet.')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'New profile' }));
    expect(screen.queryByText('No profiles yet.')).toBeNull();
    const added = within(form('New profile'));
    const save = added.getByRole('button', { name: 'Save profile' });
    expect(save).toHaveProperty('disabled', true);
    await userEvent.type(added.getByRole('textbox', { name: 'Name' }), 'Cheap');
    await userEvent.type(added.getByRole('textbox', { name: 'Model' }), 'claude-haiku-4-5');
    await userEvent.click(save);
    expect(api.actions()).toStrictEqual([
      {
        type: 'saveProfile',
        profile: { ...blankProfile('profile-rs'), name: 'Cheap', model: 'claude-haiku-4-5' },
      },
    ]);
  });

  it('drops a new profile once the host knows it', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const api = new FakeApi();
    const view = (profiles: readonly LaunchProfile[]): ReactElement => (
      <VsCodeProvider api={api}>
        <main>
          <ProfilesEditor profiles={profiles} />
        </main>
      </VsCodeProvider>
    );
    const { rerender } = render(view([]));
    await userEvent.click(screen.getByRole('button', { name: 'New profile' }));
    expect(screen.getAllByRole('group')).toHaveLength(1);
    rerender(view([{ ...blankProfile('profile-rs'), name: 'Saved' }]));
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(form('Saved')).toBeDefined();
  });
});

describe('FeatureFlags', () => {
  it('lists flags sorted and says they are read only', async () => {
    const { container } = renderView(<FeatureFlags flags={{ zeta: 1, alpha: { on: true } }} />);
    expect(
      screen.getByText(
        'Read only. Claude Code rewrites this cache from the server, so edits would not stick.',
      ),
    ).toBeDefined();
    expect(screen.getByText('read only')).toBeDefined();
    const table = screen.getByRole('table', { name: 'Cached feature flags, read only' });
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toStrictEqual(['FlagValue', 'alpha{"on":true}', 'zeta1']);
    expect(screen.queryByRole('textbox')).toBeNull();
    await expectAccessible(container);
  });

  it('says when there are no cached flags', () => {
    renderView(<FeatureFlags flags={{}} />);
    expect(screen.getByText('No cached flags.')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
