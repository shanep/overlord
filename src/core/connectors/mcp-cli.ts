// Runs an agent's own MCP command, such as `claude mcp add-json` or
// `codex mcp remove`, and turns a failure into the line the view shows.

import type { McpWrite, SettingsWriteResult } from '../agents/types.js';

const MCP_WRITE_TIMEOUT_MS = 30_000;

/** Runs the agent's CLI with args. label names the command in the error, like "claude mcp add-json". */
export async function runMcpCommand(
  input: McpWrite,
  args: readonly string[],
  label: string,
): Promise<SettingsWriteResult> {
  const result = await input.exec(input.cli.bin, args, {
    cwd: input.cwd,
    env: input.cli.env,
    timeoutMs: MCP_WRITE_TIMEOUT_MS,
  });
  if (result.code === 0) {
    return { ok: true };
  }
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
  return { ok: false, error: `${label} failed: ${detail}` };
}
