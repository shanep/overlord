// Every agent adapter, one import and one line each, so adding an agent is an
// append that never conflicts.

import { claudeCode } from './claude/index.js';
import { codex } from './codex/index.js';
import { copilot } from './copilot/index.js';
import { AgentRegistry } from './registry.js';

export const agents = new AgentRegistry([claudeCode, codex, copilot]);
