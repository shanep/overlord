// The tips index: one measure per session transcript, with the file stamp it
// was taken from, so a rescan only reads transcripts that changed. It lives
// in one JSON file in the extension's storage folder. Unlike the frustration
// counts, a measure is dropped once its transcript is gone, since tips are
// about how sessions run now.

import { z } from 'zod';

import { readOptional, writeFileAtomic } from '../knobs/atomic-file.js';

import type { SessionMeasure } from './measure.js';

export interface FileStamp {
  readonly mtimeMs: number;
  readonly size: number;
}

interface IndexEntry {
  readonly stamp: FileStamp;
  readonly measure: SessionMeasure;
}

export interface TipsIndex {
  /** Keyed by transcript path. */
  readonly entries: Map<string, IndexEntry>;
  scannedAt: number | null;
}

const count = z.number().nonnegative();

const costSchema = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
});

const measureSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  updatedAt: z.number(),
  prompts: count,
  requests: count,
  peakContext: count,
  contextTokens: count,
  compactions: count,
  cost: costSchema,
  idleRewrites: count,
  idleRewriteUsd: count,
  bigResults: count,
  extraReads: count,
  repeatedRuns: count,
  topRepeat: z.object({ command: z.string(), runs: count }).nullable(),
  toolCalls: count,
  toolErrors: count,
  denials: count,
  bashCommands: count,
  cdCommands: count,
  spawns: z.record(z.string(), count),
  subagentRequests: count,
  premiumSubagentRequests: count,
  subagentUsd: count,
  families: z.object({
    land: count,
    ci: count,
    server: count,
    buildTest: count,
    search: count,
  }),
}) satisfies z.ZodType<SessionMeasure>;

const fileSchema = z.object({
  // Bump when the measure changes meaning, so old entries are measured again.
  version: z.literal(1),
  scannedAt: z.number().nullable(),
  entries: z.record(
    z.string(),
    z.object({
      stamp: z.object({ mtimeMs: z.number(), size: z.number() }),
      measure: measureSchema,
    }),
  ),
});

export function emptyIndex(): TipsIndex {
  return { entries: new Map(), scannedAt: null };
}

function parseIndex(text: string): TipsIndex | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  return {
    entries: new Map(Object.entries(parsed.data.entries)),
    scannedAt: parsed.data.scannedAt,
  };
}

/** The saved index. A missing, corrupt or older file starts empty, since it can be rebuilt. */
export async function loadIndex(file: string): Promise<TipsIndex> {
  const text = await readOptional(file);
  return (text === null ? null : parseIndex(text)) ?? emptyIndex();
}

export async function saveIndex(file: string, index: TipsIndex): Promise<void> {
  const data: z.input<typeof fileSchema> = {
    version: 1,
    scannedAt: index.scannedAt,
    entries: Object.fromEntries(index.entries),
  };
  await writeFileAtomic({ target: file, content: `${JSON.stringify(data)}\n`, backup: null });
}
