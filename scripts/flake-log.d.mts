// Types for flake-log.mjs, so the TypeScript tests can import it.

export interface TestResult {
  readonly id: string;
  readonly file: string;
  readonly state: 'passed' | 'failed' | 'skipped' | 'pending';
  readonly message?: string;
}

export interface RunFailure {
  readonly id: string;
  readonly file: string;
  readonly message: string;
}

export interface RunEntry {
  readonly at: number;
  readonly cwd: string;
  readonly fingerprint: string | null;
  readonly failed: readonly RunFailure[];
  readonly passed: readonly string[];
  readonly passedFiles: readonly string[];
}

export interface Flake {
  readonly id: string;
  readonly file: string;
  readonly failures: number;
  readonly lastAt: number;
  readonly lastMessage: string;
  readonly worktrees: number;
}

export function defaultLogPath(): string;
export function fingerprint(cwd: string): string | null;
export function runEntry(input: {
  readonly at: number;
  readonly cwd: string;
  readonly fingerprint: string | null;
  readonly results: readonly TestResult[];
  readonly priorFailed: ReadonlySet<string>;
}): RunEntry;
export function readLog(file: string): RunEntry[];
export function appendLog(file: string, entry: RunEntry): void;
export function failedAt(entries: readonly RunEntry[], fingerprint: string | null): Set<string>;
export function findFlakes(entries: readonly RunEntry[]): Flake[];
