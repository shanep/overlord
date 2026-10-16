// Public surface of the transcript source.

export type { IngestResult, SessionAccumulatorOptions } from './accumulator.js';
export { SessionAccumulator } from './accumulator.js';
export type { ModelPrice, PriceTable } from './pricing.js';
export { DEFAULT_PRICES, estimateCost, findPrice } from './pricing.js';
export type { ReadResult } from './reader.js';
export { IncrementalReader, LineSplitter, readAllLines } from './reader.js';
export type { LoadOptions, SessionFileInfo, SessionTarget } from './scanner.js';
export { loadSession, scanSessions } from './scanner.js';
export type { TranscriptRecord } from './schemas.js';
export { parseTranscriptLine } from './schemas.js';
export type { SubagentFile, SubagentMeta } from './subagents.js';
export { listSubagentFiles, readSubagentMeta } from './subagents.js';
export type { TranscriptWatcherOptions, WatchFactory, WatchHandle } from './watcher.js';
export { TranscriptWatcher } from './watcher.js';
