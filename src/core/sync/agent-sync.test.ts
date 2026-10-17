// Config sync for Codex and Copilot over temp homes: the agents/<id>/ layout,
// key by key settings, MCP servers through each agent's store, the denylist,
// and a repo with only Claude Code's global/ applying exactly as before.

import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Connector } from '../../shared/connectors.js';
import type { ConfigItem } from '../../shared/model.js';
import { claudeCode } from '../agents/claude/index.js';
import { codex as codexAdapter } from '../agents/codex/index.js';
import { codexSync } from '../agents/codex/sync.js';
import { copilot as copilotAdapter } from '../agents/copilot/index.js';
import { copilotSync } from '../agents/copilot/sync.js';
import type {
  AgentAdapter,
  McpRead,
  McpServerConfig,
  McpStore,
  SettingsWriteResult,
} from '../agents/types.js';

import type { Action } from './actions.js';
import { describeAction } from './actions.js';
import { planAgentAdopt } from './agent-adopt.js';
import { agentInventory } from './agent-inventory.js';
import { readAgentManifest } from './agent-manifest.js';
import type { AgentSyncTarget } from './agent-plan.js';
import { agentSyncTargets } from './agent-plan.js';
import { applyPlan, backupDirName, type ApplyDeps, type ApplyResult } from './apply.js';
import { isDeniedAgentPath, isDeniedSettingPath } from './denylist.js';
import type { Exec } from './exec.js';
import { scanInventory } from './inventory.js';
import { emptyManifest, type Manifest } from './manifest.js';
import { planAll, planApply } from './plan.js';
import { createStatusResolver } from './repo-status.js';
import { createMemorySecretStore, type SecretStore } from './secrets.js';
import { fakePaths, isolatedExec, scratchDir, writeTree } from './test-helpers/fixtures.js';

const exec: Exec = isolatedExec();

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

const now = new Date('2026-10-17T12:00:00.000Z');

function codexTarget(home: string): AgentSyncTarget {
  return {
    agent: 'codex',
    name: 'Codex CLI',
    short: 'Codex',
    sync: codexSync,
    dir: path.join(home, '.codex'),
    mcpStore: true,
  };
}

function copilotTarget(home: string): AgentSyncTarget {
  return {
    agent: 'copilot',
    name: 'Copilot CLI',
    short: 'Copilot',
    sync: copilotSync,
    dir: path.join(home, '.copilot'),
    mcpStore: true,
  };
}

interface StoreCall {
  readonly op: 'add' | 'remove';
  readonly name: string;
  readonly server?: McpServerConfig;
}

/** An MCP store that records what it was asked and changes nothing on disk. */
function recordingStore(calls: StoreCall[]): McpStore {
  return {
    scopes: ['user'],
    read: async (): Promise<McpRead> => {
      await Promise.resolve();
      return { servers: [], errors: [] };
    },
    list: async (): Promise<Connector[]> => {
      await Promise.resolve();
      return [];
    },
    add: async (input): Promise<SettingsWriteResult> => {
      await Promise.resolve();
      calls.push({ op: 'add', name: input.name, server: input.server });
      return { ok: true };
    },
    remove: async (input): Promise<SettingsWriteResult> => {
      await Promise.resolve();
      calls.push({ op: 'remove', name: input.name });
      return { ok: true };
    },
  };
}

/** What stopped the run, or null when every action ran. */
async function failureOf(
  actions: readonly Action[],
  options: ApplyDeps,
): Promise<ApplyResult['failed']> {
  const result = await applyPlan(actions, options);
  return result.failed;
}

async function itemsOf(target: AgentSyncTarget, repo: string): Promise<ConfigItem[]> {
  return agentInventory(target, await createStatusResolver(exec, repo), 'box');
}

function deps(home: string, extra: Partial<ApplyDeps> = {}): ApplyDeps {
  return {
    exec,
    secrets: createMemorySecretStore(),
    paths: fakePaths(home),
    now: () => now,
    platform: 'linux',
    ...extra,
  };
}

const CODEX_TOML = `# My Codex setup. Keep this comment.
model = "gpt-5"

# Reasoning
model_reasoning_effort = "low"   # trailing note
preferred_auth_method = "chatgpt"

[tui]
# notifications on
notifications = true

[projects."/Users/me/repo"]
trust_level = "trusted"

[mcp_servers.docs]
command = "npx"
args = ["docs-mcp"]
`;

describe('a repo with only global/', () => {
  it('plans the same actions with or without agents, even when their folders exist', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(repo, {
      'global/CLAUDE.md': 'shared',
      'global/settings.json': '{"model":"opus"}',
      'agents/a.md': 'a',
    });
    await writeTree(home, {
      '.codex/config.toml': CODEX_TOML,
      '.codex/AGENTS.md': 'codex rules',
      '.copilot/settings.json': '{"model":"x"}',
    });
    const manifest: Manifest = {
      ...emptyManifest(),
      items: [
        {
          id: 'claude-md',
          kind: 'claude-md',
          source: 'global/CLAUDE.md',
          target: '~/.claude/CLAUDE.md',
          mode: 'link',
        },
        {
          id: 'settings',
          kind: 'settings',
          source: 'global/settings.json',
          target: '~/.claude/settings.json',
          mode: 'generate',
        },
        {
          id: 'agent:a',
          kind: 'agent',
          source: 'agents/a.md',
          target: '~/.claude/agents/a.md',
          mode: 'link',
        },
      ],
    };
    const paths = fakePaths(home);
    const agents = [codexTarget(home), copilotTarget(home)];
    const before = await planApply(manifest, repo, paths, 'box');
    expect(await planAll(manifest, repo, { paths, host: 'box', agents })).toStrictEqual(before);
    const result = await applyPlan(before, deps(home));
    expect(result.failed).toBeNull();
    expect(await planAll(manifest, repo, { paths, host: 'box', agents })).toStrictEqual([]);
    // Nothing of the other agents was touched.
    expect(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe(CODEX_TOML);
  });
});

describe('Codex settings', () => {
  it('sets each synced key in config.toml and keeps every comment', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(repo, {
      'agents/codex/overlord.json': JSON.stringify({
        version: 1,
        settings: 'agents/codex/config.json',
      }),
      'agents/codex/config.json': JSON.stringify({
        model: 'gpt-5-codex',
        model_reasoning_effort: 'low',
        tui: { notifications: false },
        // Neither of these may reach the file: one is denied, the other per machine.
        preferred_auth_method: 'api',
        projects: { '/x': { trust_level: 'trusted' } },
      }),
      'agents/codex/machines/box.json': JSON.stringify({ sandbox_mode: 'workspace-write' }),
    });
    await writeTree(home, { '.codex/config.toml': CODEX_TOML });
    const target = codexTarget(home);
    const file = path.join(home, '.codex', 'config.toml');
    const actions = await planAll(emptyManifest(), repo, {
      paths: fakePaths(home),
      host: 'box',
      agents: [target],
    });
    expect(actions).toStrictEqual([
      { kind: 'backup', path: file, agent: 'codex' },
      {
        kind: 'set-keys',
        agent: 'codex',
        target: file,
        format: 'toml',
        entries: [
          { path: ['model'], value: 'gpt-5-codex' },
          { path: ['sandbox_mode'], value: 'workspace-write' },
          { path: ['tui', 'notifications'], value: false },
        ],
      },
    ]);
    expect(describeAction(must(actions[1]), home)).toBe(
      'set     model, sandbox_mode, tui.notifications in ~/.codex/config.toml',
    );

    const result = await applyPlan(actions, deps(home));
    expect(result.failed).toBeNull();
    const after = await readFile(file, 'utf8');
    expect(after).toBe(
      CODEX_TOML.replace('model = "gpt-5"', 'model = "gpt-5-codex"')
        .replace('notifications = true', 'notifications = false')
        .replace(
          'preferred_auth_method = "chatgpt"\n',
          'preferred_auth_method = "chatgpt"\nsandbox_mode = "workspace-write"\n',
        ),
    );
    // The run's backup of the old file sits in a folder named for the agent.
    const backup = path.join(home, '.claude', 'backups', backupDirName(now), 'codex');
    expect(await readFile(path.join(backup, '.codex', 'config.toml'), 'utf8')).toBe(CODEX_TOML);
    expect(
      await planAll(emptyManifest(), repo, {
        paths: fakePaths(home),
        host: 'box',
        agents: [target],
      }),
    ).toStrictEqual([]);
  });

  it('copies only the keys that sync into the repo when adopted', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(home, {
      '.codex/config.toml': `notify = ["${home}/bin/notify"]\n${CODEX_TOML}[hooks.state]\nseen = true\n`,
    });
    const target = codexTarget(home);
    const items = await itemsOf(target, repo);
    const item = items.find((entry) => entry.kind === 'settings');
    expect(item?.status).toBe('local-only');
    const plan = await planAgentAdopt({
      repoRoot: repo,
      target,
      item: must(item),
      home,
      host: 'box',
    });
    expect(plan.ok && plan.question).toBe(
      "Copy Codex's settings from config.toml into the config repo? Each machine sets them one key at a time.",
    );
    expect(plan.ok && (await failureOf(plan.actions, deps(home)))).toBeNull();
    const shared: unknown = JSON.parse(
      await readFile(path.join(repo, 'agents', 'codex', 'config.json'), 'utf8'),
    );
    expect(shared).toStrictEqual({
      model: 'gpt-5',
      model_reasoning_effort: 'low',
      tui: { notifications: true },
    });
    const machine: unknown = JSON.parse(
      await readFile(path.join(repo, 'agents', 'codex', 'machines', 'box.json'), 'utf8'),
    );
    expect(machine).toStrictEqual({ notify: [`${home}/bin/notify`] });
    const manifest = await readAgentManifest(repo, 'codex');
    expect(manifest.ok && manifest.manifest.settings).toBe('agents/codex/config.json');
    const again = await agentInventory(target, await createStatusResolver(exec, repo), 'box');
    expect(again.find((entry) => entry.kind === 'settings')?.status).toBe('versioned');
  });
});

describe('Copilot', () => {
  it('sets settings keys in a commented settings.json and leaves the rest alone', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(repo, {
      'agents/copilot/overlord.json': JSON.stringify({
        version: 1,
        settings: 'agents/copilot/settings.json',
      }),
      'agents/copilot/settings.json': JSON.stringify({ model: 'gpt-5', theme: 'dark' }),
    });
    await writeTree(home, {
      '.copilot/settings.json':
        '// Copilot writes this file.\n{\n  "model": "claude",\n  "trusted_folders": ["/Users/me"]\n}\n',
    });
    const target = copilotTarget(home);
    const actions = await planAll(emptyManifest(), repo, {
      paths: fakePaths(home),
      host: 'box',
      agents: [target],
    });
    expect(await failureOf(actions, deps(home))).toBeNull();
    expect(await readFile(path.join(home, '.copilot', 'settings.json'), 'utf8')).toBe(
      '// Copilot writes this file.\n{\n  "model": "gpt-5",\n  "trusted_folders": [\n    "/Users/me"\n  ],\n  "theme": "dark"\n}\n',
    );
  });

  it('adopts the instructions file into agents/copilot and links it on the next machine', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(home, { '.copilot/copilot-instructions.md': 'be brief' });
    const target = copilotTarget(home);
    const items = await agentInventory(target, await createStatusResolver(exec, repo), 'box');
    const item = items.find((entry) => entry.kind === 'claude-md');
    expect(item).toMatchObject({
      id: 'copilot:user:claude-md:copilot-instructions.md',
      agent: 'copilot',
      name: 'copilot-instructions.md (Copilot)',
      status: 'local-only',
    });
    const plan = await planAgentAdopt({
      repoRoot: repo,
      target,
      item: must(item),
      home,
      host: 'box',
    });
    expect(plan.ok && plan.question).toBe(
      "Move Copilot's copilot-instructions.md into the config repo and link it back?",
    );
    expect(plan.ok && (await failureOf(plan.actions, deps(home)))).toBeNull();
    const inRepo = path.join(repo, 'agents', 'copilot', 'copilot-instructions.md');
    expect(await readlink(path.join(home, '.copilot', 'copilot-instructions.md'))).toBe(inRepo);
    expect(await readAgentManifest(repo, 'copilot')).toStrictEqual({
      ok: true,
      manifest: {
        version: 1,
        items: [
          {
            id: 'claude-md:copilot-instructions',
            kind: 'claude-md',
            source: 'agents/copilot/copilot-instructions.md',
            target: 'copilot-instructions.md',
            mode: 'link',
          },
        ],
        settings: null,
        mcp: null,
      },
    });

    const second = await scratchDir();
    await writeTree(second, { '.copilot/settings.json': '{}' });
    const actions = await planAll(emptyManifest(), repo, {
      paths: fakePaths(second),
      host: 'other',
      agents: [copilotTarget(second)],
    });
    expect(await failureOf(actions, deps(second))).toBeNull();
    expect(await readlink(path.join(second, '.copilot', 'copilot-instructions.md'))).toBe(inRepo);
  });

  it('adds MCP servers through the store, with secrets filled in from the keychain', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(repo, {
      'agents/copilot/overlord.json': JSON.stringify({
        version: 1,
        mcp: 'agents/copilot/mcp.json',
      }),
      'agents/copilot/mcp.json': JSON.stringify({
        mcpServers: {
          same: { type: 'local', command: 'npx', args: ['same'], tools: ['*'] },
          fresh: { type: 'http', url: 'https://f', headers: { Authorization: '${secret:F}' } },
          changed: { command: 'new' },
        },
      }),
    });
    await writeTree(home, {
      '.copilot/mcp-config.json': JSON.stringify({
        mcpServers: {
          same: { type: 'local', command: 'npx', args: ['same'], tools: ['*'] },
          changed: { type: 'local', command: 'old', args: [] },
        },
      }),
    });
    const target = copilotTarget(home);
    const actions = await planAll(emptyManifest(), repo, {
      paths: fakePaths(home),
      host: 'box',
      agents: [target],
    });
    expect(actions.map((action) => describeAction(action, home))).toStrictEqual([
      'backup  ~/.copilot/mcp-config.json',
      'mcp     remove changed from Copilot to add it again',
      'mcp     add changed to Copilot',
      'mcp     add fresh to Copilot',
    ]);
    const calls: StoreCall[] = [];
    const secrets: SecretStore = createMemorySecretStore({ F: 'Bearer real' });
    const result = await applyPlan(
      actions,
      deps(home, {
        secrets,
        mcp: async (agent) => {
          await Promise.resolve();
          expect(agent).toBe('copilot');
          return {
            store: recordingStore(calls),
            cli: { bin: 'copilot', env: {} },
          };
        },
      }),
    );
    expect(result.failed).toBeNull();
    expect(calls).toStrictEqual([
      { op: 'remove', name: 'changed' },
      { op: 'add', name: 'changed', server: { command: 'new', type: 'stdio', args: [] } },
      {
        op: 'add',
        name: 'fresh',
        server: { type: 'http', url: 'https://f', headers: { Authorization: 'Bearer real' } },
      },
    ]);
    const backup = path.join(must(result.backupDir), 'copilot', '.copilot', 'mcp-config.json');
    const info = await lstat(backup);
    expect(info.isFile()).toBe(true);
  });

  it('adopts an MCP server with its secret moved to the keychain', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    const token = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await writeTree(home, {
      '.copilot/mcp-config.json': JSON.stringify({
        mcpServers: {
          gh: { type: 'local', command: 'gh-mcp', args: [], env: { GITHUB_TOKEN: token } },
        },
      }),
    });
    const target = copilotTarget(home);
    const items = await itemsOf(target, repo);
    const item = items.find((entry) => entry.kind === 'mcp-server');
    expect(item?.status).toBe('local-only');
    const plan = await planAgentAdopt({
      repoRoot: repo,
      target,
      item: must(item),
      home,
      host: 'box',
    });
    expect(plan.ok && plan.question).toBe(
      'Copy the gh MCP server from Copilot into the config repo? Its secrets go in the keychain, not the repo.',
    );
    const secrets = createMemorySecretStore();
    expect(plan.ok && (await failureOf(plan.actions, deps(home, { secrets })))).toBeNull();
    const text = await readFile(path.join(repo, 'agents', 'copilot', 'mcp.json'), 'utf8');
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toStrictEqual({
      mcpServers: {
        gh: {
          type: 'local',
          command: 'gh-mcp',
          args: [],
          env: { GITHUB_TOKEN: '${secret:MCP_GH_GITHUB_TOKEN}' },
        },
      },
    });
    expect(await secrets.get('MCP_GH_GITHUB_TOKEN')).toBe(token);
    expect(plan.ok && plan.actions.map((action) => describeAction(action, home))).toContain(
      'secret  MCP_GH_GITHUB_TOKEN (saved in the keychain)',
    );
  });
});

describe('Claude Code MCP', () => {
  it('adds through the Claude Code store with every field kept, and fails without a store', async () => {
    const home = await scratchDir();
    const action: Action = {
      kind: 'mcp-add',
      agent: 'claude-code',
      short: 'Claude Code',
      name: 'auth',
      config: { type: 'http', url: 'https://a', oauth: { clientId: 'x' } },
    };
    const calls: StoreCall[] = [];
    const store = recordingStore(calls);
    const result = await applyPlan(
      [action],
      deps(home, {
        mcp: async () => {
          await Promise.resolve();
          return { store, cli: { bin: 'claude', env: {} } };
        },
      }),
    );
    expect(result.failed).toBeNull();
    expect(calls).toStrictEqual([
      {
        op: 'add',
        name: 'auth',
        server: { type: 'http', url: 'https://a', oauth: { clientId: 'x' } },
      },
    ]);
    const failed = await failureOf([action], deps(home));
    expect(failed?.message).toBe("Overlord cannot reach claude-code's MCP servers here");
  });
});

describe('Codex MCP', () => {
  it('reads servers from config.toml and adds only the missing ones', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(repo, {
      'agents/codex/overlord.json': JSON.stringify({ version: 1, mcp: 'agents/codex/mcp.json' }),
      'agents/codex/mcp.json': JSON.stringify({
        mcpServers: {
          docs: { type: 'stdio', command: 'npx', args: ['docs-mcp'] },
          web: { type: 'http', url: 'https://w' },
        },
      }),
    });
    await writeTree(home, { '.codex/config.toml': CODEX_TOML });
    const actions = await planAll(emptyManifest(), repo, {
      paths: fakePaths(home),
      host: 'box',
      agents: [codexTarget(home)],
    });
    expect(actions.map((action) => describeAction(action, home))).toStrictEqual([
      'backup  ~/.codex/config.toml',
      'mcp     add web to Codex',
    ]);
  });

  it('skips the servers when config.toml does not parse, and never removes for a bad repo config', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(repo, {
      'agents/codex/overlord.json': JSON.stringify({ version: 1, mcp: 'agents/codex/mcp.json' }),
      'agents/codex/mcp.json': JSON.stringify({ mcpServers: { docs: { args: ['x'] } } }),
    });
    await writeTree(home, { '.codex/config.toml': 'model = \n' });
    const place = { paths: fakePaths(home), host: 'box', agents: [codexTarget(home)] };
    const unreadable = await planAll(emptyManifest(), repo, place);
    expect(unreadable.map((action) => describeAction(action, home))).toStrictEqual([
      'note    Codex: config.toml could not be read, so its MCP servers were skipped',
    ]);
    await writeTree(home, { '.codex/config.toml': CODEX_TOML });
    const bad = await planAll(emptyManifest(), repo, place);
    expect(bad.map((action) => describeAction(action, home))).toStrictEqual([
      'note    Codex docs: the repo config has neither a command nor a URL',
    ]);
  });
});

describe('a key the TOML editor refuses', () => {
  it('is left out of the plan with a note, and the other keys still apply', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    await writeTree(repo, {
      'agents/codex/overlord.json': JSON.stringify({
        version: 1,
        settings: 'agents/codex/config.json',
      }),
      'agents/codex/config.json': JSON.stringify({ model: 'o3', tui: { theme: 'light' } }),
    });
    await writeTree(home, { '.codex/config.toml': 'model = "gpt-5"\ntui = { theme = "dark" }\n' });
    const place = { paths: fakePaths(home), host: 'box', agents: [codexTarget(home)] };
    const actions = await planAll(emptyManifest(), repo, place);
    const lines = actions.map((action) => describeAction(action, home));
    expect(lines[0]).toMatch(
      /^note {4}Codex: config\.toml cannot take tui\.theme: .+ Set it by hand\.$/u,
    );
    expect(lines.slice(1)).toStrictEqual([
      'backup  ~/.codex/config.toml',
      'set     model in ~/.codex/config.toml',
    ]);
    expect(await failureOf(actions, deps(home))).toBeNull();
    expect(await readFile(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe(
      'model = "o3"\ntui = { theme = "dark" }\n',
    );
  });
});

describe('the denylist', () => {
  it('never lists sign in files, sessions, history, logs, databases or caches', async () => {
    const home = await scratchDir();
    await writeTree(home, {
      '.codex/AGENTS.md': 'rules',
      '.codex/auth.json': '{"tokens":{}}',
      '.codex/history.jsonl': '{}',
      '.codex/sessions/2026/10/17/rollout-1.jsonl': '{}',
      '.codex/log/codex-tui.log': 'x',
      '.codex/state_5.sqlite': 'x',
      '.codex/skills/.system/builtin/SKILL.md': 'x',
      '.codex/skills/voice/SKILL.md': 'x',
      '.codex/skills/oauth-helper/SKILL.md': 'x',
      '.copilot/copilot-instructions.md': 'x',
      '.copilot/config.json': '{"logged_in_users":[{"login":"me"}]}',
      '.copilot/session-state/abc/events.jsonl': '{}',
      '.copilot/agents/review.agent.md': 'x',
      '.copilot/skills/write/SKILL.md': 'x',
    });
    const resolver = await createStatusResolver(exec, null);
    const ids = [
      ...(await agentInventory(codexTarget(home), resolver, 'box')),
      ...(await agentInventory(copilotTarget(home), resolver, 'box')),
    ].map((item) => item.id);
    expect(ids).toStrictEqual([
      'codex:user:claude-md:AGENTS.md',
      'codex:user:skill:voice',
      'copilot:user:claude-md:copilot-instructions.md',
      'copilot:user:skill:write',
      'copilot:user:agent:review.agent.md',
    ]);
  });

  it('denies agent paths and settings keys that hold credentials or state', () => {
    const codex = '/h/.codex';
    for (const denied of [
      'auth.json',
      'history.jsonl',
      'sessions/x.jsonl',
      'log/codex.log',
      'logs_1.sqlite',
      'state_5.sqlite-wal',
      'cache/x',
      'skills/token-tool/SKILL.md',
      'id_ed25519',
    ]) {
      expect(isDeniedAgentPath(path.join(codex, denied), codex)).toBe(true);
    }
    for (const kept of ['AGENTS.md', 'config.toml', 'skills/voice/SKILL.md']) {
      expect(isDeniedAgentPath(path.join(codex, kept), codex)).toBe(false);
    }
    const copilot = '/h/.copilot';
    for (const denied of ['config.json', 'session-state/a/events.jsonl', 'hosts.json', 'oauth']) {
      expect(isDeniedAgentPath(path.join(copilot, denied), copilot)).toBe(true);
    }
    for (const denied of [
      ['preferred_auth_method'],
      ['hooks', 'state', 'x'],
      ['model_providers', 'x', 'experimental_bearer_token'],
      ['history'],
      ['sqlite_home'],
      ['logged_in_users'],
      ['lastLoggedInUser'],
    ]) {
      expect(isDeniedSettingPath(denied)).toBe(true);
    }
    for (const kept of [
      ['model'],
      ['model_auto_compact_token_limit'],
      ['hooks', 'x'],
      ['tui', 'theme'],
    ]) {
      expect(isDeniedSettingPath(kept)).toBe(false);
    }
  });
});

describe('scanInventory', () => {
  it('adds agent items after Claude Code items, and none without targets', async () => {
    const home = await scratchDir();
    await writeTree(home, { '.claude/CLAUDE.md': 'x', '.codex/AGENTS.md': 'rules' });
    const base = { paths: fakePaths(home), exec, configRepoRoot: null, workspace: null };
    const claude = await scanInventory(base);
    const all = await scanInventory({ ...base, agents: [codexTarget(home)], host: 'box' });
    expect(all.slice(0, claude.length)).toStrictEqual(claude);
    expect(all.slice(claude.length).map((item) => item.id)).toStrictEqual([
      'codex:user:claude-md:AGENTS.md',
    ]);
    expect(claude.some((item) => item.agent !== undefined)).toBe(false);
  });
});

describe('agentSyncTargets', () => {
  it('keeps only adapters with a sync part and resolves their folders from the environment', () => {
    const withSync: AgentAdapter = {
      ...codexAdapter,
      config: { settingsFormat: 'toml', ...codexAdapter.config, sync: codexSync },
    };
    const targets = agentSyncTargets([claudeCode, withSync], '/h', { CODEX_HOME: '/elsewhere' });
    expect(targets).toStrictEqual([
      {
        agent: 'codex',
        name: 'Codex CLI',
        short: 'Codex',
        sync: codexSync,
        dir: '/elsewhere',
        mcpStore: true,
      },
    ]);
  });

  it('lists the Codex adapter items from CODEX_HOME', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    const codexHome = path.join(home, 'codex-home');
    await writeTree(codexHome, {
      'AGENTS.md': 'be brief',
      'skills/ship/SKILL.md': '---\nname: ship\ndescription: Ship it.\n---\n',
      'config.toml': 'model = "gpt-6-luna"\n\n[mcp_servers.docs]\nurl = "https://x"\n',
    });
    const targets = agentSyncTargets([claudeCode, codexAdapter], home, { CODEX_HOME: codexHome });
    expect(targets.map((target) => [target.agent, target.dir])).toStrictEqual([
      ['codex', codexHome],
    ]);
    const items = await agentInventory(
      must(targets[0]),
      await createStatusResolver(exec, repo),
      'box',
    );
    expect(items.every((entry) => entry.agent === 'codex')).toBe(true);
    expect(items.map((entry) => entry.kind)).toStrictEqual(
      expect.arrayContaining(['claude-md', 'skill', 'settings', 'mcp-server']),
    );
  });

  it('lists the Copilot adapter items from COPILOT_HOME', async () => {
    const home = await scratchDir();
    const repo = await scratchDir();
    const copilotHome = path.join(home, 'copilot-home');
    await writeTree(copilotHome, {
      'copilot-instructions.md': 'be brief',
      'skills/ship/SKILL.md': '---\nname: ship\ndescription: Ship it.\n---\n',
      'agents/checker.md': '---\nname: checker\n---\n',
      'settings.json': '{"model":"gpt-5"}',
      'mcp-config.json': '{"mcpServers":{"docs":{"type":"http","url":"https://x"}}}',
    });
    const targets = agentSyncTargets([claudeCode, copilotAdapter], home, {
      COPILOT_HOME: copilotHome,
    });
    expect(targets.map((target) => [target.agent, target.dir])).toStrictEqual([
      ['copilot', copilotHome],
    ]);
    const items = await agentInventory(
      must(targets[0]),
      await createStatusResolver(exec, repo),
      'box',
    );
    expect(items.every((entry) => entry.agent === 'copilot')).toBe(true);
    expect(items.map((entry) => entry.kind)).toStrictEqual(
      expect.arrayContaining(['claude-md', 'skill', 'agent', 'settings', 'mcp-server']),
    );
  });
});
