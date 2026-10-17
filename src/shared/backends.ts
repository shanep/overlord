// The model endpoint a session's replies came from. Claude Code records each
// reply's model in the transcript, and replies through the boisestate.ai
// bridge carry the backend's own model ids, so the model alone tells them apart.

/** The seven models the boisestate.ai api key grants, by backend model_id. */
export const BOISESTATE_MODEL_IDS = [
  'global.anthropic.claude-opus-5-5',
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'global.openai.gpt-6-sol',
  'global.openai.gpt-5.6-terra',
  'global.openai.gpt-6-luna',
  'google.gemma-4-31b',
] as const;

/** Anthropic's own API, or the boisestate.ai bridge. */
export type Backend = 'anthropic' | 'boisestate';

const BOISESTATE_MODELS: ReadonlySet<string> = new Set(BOISESTATE_MODEL_IDS);

/** The backend behind a reply's model. A session with no reply yet counts as Anthropic. */
export function backendOf(model: string | null): Backend {
  return model !== null && BOISESTATE_MODELS.has(model) ? 'boisestate' : 'anthropic';
}
