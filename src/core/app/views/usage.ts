// The usage view, from ~/.claude/stats-cache.json.

import type { UsageState } from '../../../shared/protocol.js';
import type { ClaudePaths } from '../../paths.js';
import { EMPTY_USAGE, readUsageHistory } from '../../surfaces/usage.js';

export async function loadUsage(
  paths: ClaudePaths,
  report: (source: string, message: string) => void,
): Promise<UsageState> {
  const read = await readUsageHistory(paths);
  for (const error of read.errors) {
    report('usage', error.message);
  }
  return read.history?.usage ?? EMPTY_USAGE;
}
