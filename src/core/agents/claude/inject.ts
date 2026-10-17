// How Overlord's text reaches a Claude Code session. Hooks come first: the
// connector briefing and the coordination and launch check notes go out as
// additionalContext, with the launch check's summary as the systemMessage the
// user sees (see answerClaudeHook in hooks.ts). Claude also takes
// --append-system-prompt, which only matters once its hooks are off.

import type { InjectFacet } from '../types.js';

export const claudeInject: InjectFacet = {
  routes: ['hook', 'launch-argument'],
  launchArgs: (text) => ['--append-system-prompt', text],
};
