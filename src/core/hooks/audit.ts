// Append-only JSONL log of every permission decision an auto-approve rule made.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const auditEntrySchema = z.object({
  at: z.number(),
  requestId: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  toolName: z.string(),
  ruleId: z.string(),
  behavior: z.enum(['allow', 'deny']),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

function parseLine(line: string): AuditEntry | null {
  try {
    const parsed = auditEntrySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class AuditLog {
  // Appends run one after another so lines never interleave.
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async append(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify(auditEntrySchema.parse(entry))}\n`;
    const previous = this.tail;
    const write = (async (): Promise<void> => {
      await previous;
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
    })();
    this.tail = write.catch(() => {
      // The caller sees this failure; the next append still runs.
    });
    return write;
  }

  /** Every valid entry, oldest first. A missing file reads as empty. */
  async read(): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const entries: AuditEntry[] = [];
    for (const line of text.split('\n')) {
      const entry = parseLine(line);
      if (entry !== null) {
        entries.push(entry);
      }
    }
    return entries;
  }
}
