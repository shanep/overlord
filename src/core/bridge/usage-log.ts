// The boisestate.ai bridge's usage log. The backend has no usage page or
// API, so the sidecar appends one JSON line per finished call, with the
// backend's own token counts, and the Usage view sums them by day and
// model. Every client of the sidecar counts, not only Claude Code.

import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { BridgeUsage, BridgeUsageDay, BridgeUsageModel } from '../../shared/bridge-usage.js';
import type { CallUsage } from '../proxy/upstream.js';

/** Where every sidecar on this machine logs, in Overlord's own folder. */
export function bridgeUsageFile(home: string): string {
  return path.join(home, '.overlord', 'boisestate-usage.jsonl');
}

const lineSchema = z.object({
  at: z.number(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

/** Appends one call to the log. A failure goes to report, since the call itself went fine. */
export async function logUsage(
  file: string,
  usage: CallUsage,
  at: number,
  report: (message: string) => void,
): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ at, ...usage })}\n`);
  } catch (error: unknown) {
    report(`could not log usage: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The local calendar day of an epoch ms, as YYYY-MM-DD like the rest of the Usage view. */
function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

interface Totals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

function add(map: Map<string, Totals>, key: string, line: z.infer<typeof lineSchema>): void {
  const totals = map.get(key) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
  totals.calls += 1;
  totals.inputTokens += line.inputTokens;
  totals.outputTokens += line.outputTokens;
  map.set(key, totals);
}

/** The log summed by day, oldest first, and by model, busiest first. Null when it has no calls. */
export function summarizeUsage(text: string): BridgeUsage | null {
  const days = new Map<string, Totals>();
  const models = new Map<string, Totals>();
  for (const raw of text.split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    const line = lineSchema.safeParse(value);
    if (line.success) {
      add(days, localDay(line.data.at), line.data);
      add(models, line.data.model, line.data);
    }
  }
  if (days.size === 0) {
    return null;
  }
  const dayRows: BridgeUsageDay[] = [...days]
    .map(([date, totals]) => ({ date, ...totals }))
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const modelRows: BridgeUsageModel[] = [...models]
    .map(([model, totals]) => ({ model, ...totals }))
    .toSorted((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return { days: dayRows, models: modelRows };
}
