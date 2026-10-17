// How Overlord's text reaches a Copilot CLI session. Hooks come first: the
// connector briefing, the launch check and the coordination notes go out as
// additionalContext on sessionStart and postToolUse (see hooks.ts). Copilot
// 1.0.89 has no launch flag that adds instructions, so with its hooks off a
// Launcher run gets the text in front of its first prompt, and a terminal
// session gets nothing.

import type { InjectFacet } from '../types.js';

export const copilotInject: InjectFacet = {
  routes: ['hook', 'first-prompt'],
  promptPrefix: (text, prompt) => `${text}\n\n${prompt}`,
};
