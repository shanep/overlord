// How Overlord's text reaches a Codex session: coordination notes, the launch
// check and the connector briefing. Sessions Overlord starts, from the
// Launcher or in a tab, get it as `-c developer_instructions=...`, which
// Codex adds to its own instructions instead of replacing them. Codex skips
// a hook until the user trusts it in /hooks, so a launch never counts on the
// hooks. Sessions started elsewhere get it from Overlord's hooks once they are
// trusted, as SessionStart and UserPromptSubmit additionalContext.

import type { ConfigOverride } from '../../knobs/facet.js';
import { configArgs } from '../../knobs/launch.js';
import type { InjectFacet } from '../talk-types.js';

function instructions(text: string): readonly ConfigOverride[] {
  return [{ key: ['developer_instructions'], value: text }];
}

export const codexInject: InjectFacet = {
  routes: ['hook', 'launch-argument'],
  launchFirst: true,
  launchArgs: (text) => configArgs(instructions(text)),
  launchConfig: instructions,
};
