import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SpawnLookup, SubagentActivity, SubagentMeta } from './subagents.js';
import {
  agentIdFromFileName,
  buildSubagentNode,
  listSubagentFiles,
  parseSubagentMeta,
  readSubagentMeta,
  spawnCompletion,
} from './subagents.js';
import { makeTemporaryDirectory, removeDir } from './test-helpers/fixtures.js';

const NO_LOOKUP: SpawnLookup = {
  ownerOf: () => null,
  resultOf: () => null,
  notificationOf: () => null,
};

const META: SubagentMeta = {
  agentType: 'Explore',
  description: 'Find things',
  toolUseId: 'toolu_1',
  spawnDepth: 2,
  requestShape: 'background',
  model: 'claude-haiku-5-5',
};

const ACTIVITY: SubagentActivity = {
  agentId: 'agent1',
  sessionId: 'sess',
  transcriptPath: '/x/agent-agent1.jsonl',
  startedAt: 100,
  liveState: 'running',
  usage: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, thinking: 5 },
  toolCallCount: 7,
  currentTool: 'Bash',
  model: null,
};

function lookup(overrides: Partial<SpawnLookup>): SpawnLookup {
  return { ...NO_LOOKUP, ...overrides };
}

function plainResult(): { at: number; ok: boolean; async: boolean } {
  return { at: 1, ok: true, async: false };
}

describe('agentIdFromFileName', () => {
  it('reads agent ids and rejects other files', () => {
    expect(agentIdFromFileName('agent-abc123.jsonl')).toBe('abc123');
    expect(agentIdFromFileName('agent-a-b.jsonl')).toBe('a-b');
    expect(agentIdFromFileName('agent-abc.meta.json')).toBeNull();
    expect(agentIdFromFileName('journal.jsonl')).toBeNull();
    expect(agentIdFromFileName('xagent-a.jsonl')).toBeNull();
    expect(agentIdFromFileName('agent-a.jsonl.bak')).toBeNull();
    expect(agentIdFromFileName('agent-.jsonl')).toBeNull();
  });
});

describe('parseSubagentMeta', () => {
  it('parses the known fields', () => {
    expect(
      parseSubagentMeta(
        JSON.stringify({
          ...META,
          parentAgentId: 'p1',
          requestNonInteractive: true,
          isFork: false,
        }),
      ),
    ).toStrictEqual({ ...META, parentAgentId: 'p1' });
  });

  it('falls back on defaults for missing or odd fields', () => {
    expect(parseSubagentMeta(JSON.stringify({ spawnDepth: -1, agentType: 3 }))).toStrictEqual({
      agentType: 'unknown',
      description: '',
      spawnDepth: 1,
    });
    expect(parseSubagentMeta(JSON.stringify({ spawnDepth: 1.5 }))?.spawnDepth).toBe(1);
  });

  it('gives null for broken JSON and non-objects', () => {
    expect(parseSubagentMeta('{')).toBeNull();
    expect(parseSubagentMeta('[]')).toBeNull();
    expect(parseSubagentMeta('null')).toBeNull();
  });
});

describe('files on disk', () => {
  let root = '';

  beforeEach(async () => {
    root = await makeTemporaryDirectory();
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it('reads a meta file and gives null when it is missing', async () => {
    const metaPath = path.join(root, 'agent-a.meta.json');
    expect(await readSubagentMeta(metaPath)).toBeNull();
    await writeFile(metaPath, JSON.stringify({ agentType: 'Plan' }));
    expect(await readSubagentMeta(metaPath)).toStrictEqual({
      agentType: 'Plan',
      description: '',
      spawnDepth: 1,
    });
  });

  it('lists subagent transcripts at any depth, sorted, and nothing for a missing folder', async () => {
    expect(await listSubagentFiles(path.join(root, 'none'))).toStrictEqual([]);
    const subagents = path.join(root, 'subagents');
    const workflow = path.join(subagents, 'workflows', 'wf_1');
    await mkdir(workflow, { recursive: true });
    await writeFile(path.join(subagents, 'agent-b.jsonl'), '');
    await writeFile(path.join(subagents, 'agent-a.jsonl'), '');
    await writeFile(path.join(subagents, 'agent-a.meta.json'), '{}');
    await writeFile(path.join(workflow, 'agent-c.jsonl'), '');
    await writeFile(path.join(workflow, 'journal.jsonl'), '');
    expect(await listSubagentFiles(root)).toStrictEqual([
      {
        agentId: 'a',
        transcriptPath: path.join(subagents, 'agent-a.jsonl'),
        metaPath: path.join(subagents, 'agent-a.meta.json'),
      },
      {
        agentId: 'b',
        transcriptPath: path.join(subagents, 'agent-b.jsonl'),
        metaPath: path.join(subagents, 'agent-b.meta.json'),
      },
      {
        agentId: 'c',
        transcriptPath: path.join(workflow, 'agent-c.jsonl'),
        metaPath: path.join(workflow, 'agent-c.meta.json'),
      },
    ]);
  });
});

describe('spawnCompletion', () => {
  it('is null while nothing has come back', () => {
    expect(spawnCompletion('t', NO_LOOKUP)).toBeNull();
  });

  it('ends a foreground agent at its tool result', () => {
    expect(
      spawnCompletion('t', lookup({ resultOf: () => ({ at: 5, ok: true, async: false }) })),
    ).toStrictEqual({
      state: 'done',
      endedAt: 5,
      failure: null,
    });
    expect(
      spawnCompletion('t', lookup({ resultOf: () => ({ at: 6, ok: false, async: false }) })),
    ).toStrictEqual({
      state: 'failed',
      endedAt: 6,
      failure: null,
    });
    expect(
      spawnCompletion(
        't',
        lookup({ resultOf: () => ({ at: 6, ok: false, async: false, error: 'API Error' }) }),
      )?.failure,
    ).toBe('API Error');
  });

  it('takes the failure of a background agent from its notification summary', () => {
    const summary = 'Agent "N1" failed: You have hit your session limit';
    const failed = lookup({ notificationOf: () => ({ at: 9, status: 'failed', summary }) });
    const done = lookup({ notificationOf: () => ({ at: 9, status: 'completed', summary }) });
    expect(spawnCompletion('t', failed)?.failure).toBe(summary);
    expect(spawnCompletion('t', done)?.failure).toBeNull();
  });

  it('waits for the notification when the result only says it launched', () => {
    expect(
      spawnCompletion('t', lookup({ resultOf: () => ({ at: 5, ok: true, async: true }) })),
    ).toBeNull();
  });

  it('uses the notification status, which wins over the result', () => {
    const states = ['completed', 'failed', 'error', 'killed'].map(
      (status) =>
        spawnCompletion(
          't',
          lookup({ resultOf: plainResult, notificationOf: () => ({ at: 9, status }) }),
        )?.state,
    );
    expect(states).toStrictEqual(['done', 'failed', 'failed', 'done']);
    expect(
      spawnCompletion('t', lookup({ notificationOf: () => ({ at: 9, status: 'completed' }) }))
        ?.endedAt,
    ).toBe(9);
  });

  it('asks the lookup about the right tool use', () => {
    const asked: string[] = [];
    spawnCompletion('toolu_x', {
      ownerOf: () => null,
      resultOf: (id) => {
        asked.push(`result:${id}`);
        return null;
      },
      notificationOf: (id) => {
        asked.push(`note:${id}`);
        return null;
      },
    });
    expect(asked).toStrictEqual(['note:toolu_x', 'result:toolu_x']);
  });
});

describe('buildSubagentNode', () => {
  it('builds a live node from meta and activity', () => {
    expect(buildSubagentNode(ACTIVITY, META, NO_LOOKUP)).toStrictEqual({
      id: 'agent1',
      sessionId: 'sess',
      parentAgentId: 'sess',
      parentToolUseId: 'toolu_1',
      agentType: 'Explore',
      description: 'Find things',
      spawnDepth: 2,
      background: true,
      state: 'running',
      startedAt: 100,
      endedAt: null,
      transcriptPath: '/x/agent-agent1.jsonl',
      usage: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, thinking: 5 },
      toolCallCount: 7,
      currentTool: 'Bash',
      model: 'claude-haiku-5-5',
    });
  });

  it('links to the thread that holds the tool use and ends with its result', () => {
    const node = buildSubagentNode(
      { ...ACTIVITY, model: 'claude-opus-5-5' },
      { ...META, requestShape: 'foreground', parentAgentId: 'meta-parent' },
      {
        ownerOf: (id) => (id === 'toolu_1' ? 'parent-agent' : null),
        resultOf: (id) => (id === 'toolu_1' ? { at: 500, ok: true, async: false } : null),
        notificationOf: () => null,
      },
    );
    expect(node.parentAgentId).toBe('parent-agent');
    expect(node.background).toBe(false);
    expect(node.state).toBe('done');
    expect(node.endedAt).toBe(500);
    expect(node.currentTool).toBeNull();
    expect(node.model).toBe('claude-opus-5-5');
  });

  it('falls back to the parent named in the meta file', () => {
    const node = buildSubagentNode(ACTIVITY, { ...META, parentAgentId: 'meta-parent' }, NO_LOOKUP);
    expect(node.parentAgentId).toBe('meta-parent');
  });

  it('handles agents with no tool use id, such as workflow agents', () => {
    const asked: string[] = [];
    const spy: SpawnLookup = {
      ownerOf: (id) => {
        asked.push(id);
        return 'x';
      },
      resultOf: () => ({ at: 1, ok: true, async: false }),
      notificationOf: () => null,
    };
    const node = buildSubagentNode(
      ACTIVITY,
      { agentType: 'workflow-subagent', description: 'w', spawnDepth: 1 },
      spy,
    );
    expect(asked).toStrictEqual([]);
    expect(node.parentToolUseId).toBeNull();
    expect(node.parentAgentId).toBe('sess');
    expect(node.state).toBe('running');
    expect(node.model).toBeNull();
    expect(node.background).toBe(false);
  });

  it('uses neutral values without a meta file', () => {
    const node = buildSubagentNode({ ...ACTIVITY, liveState: 'idle' }, null, NO_LOOKUP);
    expect(node).toMatchObject({
      parentAgentId: 'sess',
      parentToolUseId: null,
      agentType: 'unknown',
      description: '',
      spawnDepth: 1,
      background: false,
      state: 'idle',
      model: null,
    });
  });
});
