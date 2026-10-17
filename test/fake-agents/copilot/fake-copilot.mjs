// A stand-in for the copilot binary, so tests never start a real agent. Run
// it with `node fake-copilot.mjs <args>`. It writes its args to
// FAKE_COPILOT_ARGS as a JSON array, then plays the ACP script the way
// fake-acp.mjs does (FAKE_ACP_SCRIPT and the rest).
import { writeFileSync } from 'node:fs';

const argsPath = process.env.FAKE_COPILOT_ARGS ?? '';
if (argsPath !== '') {
  writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));
}

await import('../acp/fake-acp.mjs');
