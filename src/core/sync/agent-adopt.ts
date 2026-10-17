// Adopting another agent's config item into agents/<id>/ of the config repo.
// Files and folders move into the repo and link back, the way Claude Code's
// do. The settings file is never moved or linked: the keys that sync are copied
// into the repo as JSON. An MCP server is copied with its secrets taken out
// and kept in the keychain.

import type { ConfigItem } from '../../shared/model.js';

import type { Action } from './actions.js';
import { agentEntries, agentItemBase } from './agent-inventory.js';
import {
  agentManifestOrEmpty,
  serializeAgentManifest,
  upsertAgentItems,
  type AgentManifest,
} from './agent-manifest.js';
import { agentPath, type AgentSyncTarget } from './agent-plan.js';
import { entriesToObject, readSettings, settingEntries, entriesToSync } from './agent-settings.js';
import { isDeniedAgentPath } from './denylist.js';
import { hashPath, readJsonOrUndefined } from './files.js';
import { isRecord, setOwn, stableJson } from './json.js';
import { agentMachineSettingsPath, agentManifestPath, agentRepoDir, repoFile } from './layout.js';
import { extractMcpSecrets } from './mcp.js';
import { planLink, prepareTarget } from './plan-steps.js';

export type AgentAdoptPlan =
  | {
      readonly ok: true;
      readonly actions: readonly Action[];
      /** What to ask before applying, naming the agent. */
      readonly question: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** True when Overlord has no way to adopt the item, as opposed to a conflict in the repo. */
      readonly unsupported: boolean;
    };

const tag = (actions: readonly Action[], target: AgentSyncTarget): Action[] =>
  actions.map((action) => (action.kind === 'backup' ? { ...action, agent: target.agent } : action));

async function writeRepoFile(
  repoRoot: string,
  relative: string,
  content: string,
): Promise<Action[]> {
  const file = repoFile(repoRoot, relative);
  return [...(await prepareTarget(file)), { kind: 'write-file', target: file, content }];
}

async function writeManifest(
  repoRoot: string,
  target: AgentSyncTarget,
  manifest: AgentManifest,
): Promise<Action[]> {
  return writeRepoFile(repoRoot, agentManifestPath(target.agent), serializeAgentManifest(manifest));
}

function unsupported(item: ConfigItem): AgentAdoptPlan {
  return { ok: false, reason: `Overlord cannot adopt ${item.name} yet.`, unsupported: true };
}

async function adoptEntry(
  repoRoot: string,
  target: AgentSyncTarget,
  item: ConfigItem,
): Promise<AgentAdoptPlan> {
  const entries = await agentEntries(target);
  const entry = entries.find((candidate) => candidate.path === item.path);
  if (entry === undefined || isDeniedAgentPath(entry.path, target.dir)) {
    return unsupported(item);
  }
  const source = `${agentRepoDir(target.agent)}/${entry.relative}`;
  const destination = repoFile(repoRoot, source);
  const there = await hashPath(destination);
  if (there !== null && there !== (await hashPath(entry.path))) {
    return {
      ok: false,
      reason: `${source} already exists in the config repo with different content.`,
      unsupported: false,
    };
  }
  const copy: Action[] =
    there === null
      ? [
          ...(await prepareTarget(destination)),
          { kind: 'copy', source: entry.path, target: destination },
        ]
      : [];
  const manifest = upsertAgentItems(await agentManifestOrEmpty(repoRoot, target.agent), [
    {
      id: `${entry.kind}:${entry.relative.replace(/\.md$/u, '')}`,
      kind: entry.kind,
      source,
      target: entry.relative,
      mode: 'link',
    },
  ]);
  return {
    ok: true,
    actions: [
      ...copy,
      ...tag(await planLink(destination, entry.path), target),
      ...(await writeManifest(repoRoot, target, manifest)),
    ],
    question: `Move ${target.short}'s ${entry.name} into the config repo and link it back?`,
  };
}

function mentionsHome(value: unknown, home: string): boolean {
  const text = JSON.stringify(value);
  return text.includes(home) || /\/(?:Users|home)\/[^/"]+/u.test(text);
}

/** The repo file's keys with the captured ones laid over them. */
async function mergedRepoSettings(
  repoRoot: string,
  relative: string,
  captured: ReturnType<typeof entriesToSync>,
): Promise<string> {
  const existing = settingEntries(await readJsonOrUndefined(repoFile(repoRoot, relative)), 'json');
  return stableJson(entriesToObject([...existing, ...captured]));
}

async function adoptSettings(
  repoRoot: string,
  target: AgentSyncTarget,
  item: ConfigItem,
  context: { readonly home: string; readonly host: string },
): Promise<AgentAdoptPlan> {
  const spec = target.sync.settings;
  if (spec === null) {
    return unsupported(item);
  }
  const live = await readSettings(agentPath(target, spec.file), spec.format);
  if (!live.ok) {
    return {
      ok: false,
      reason: `${spec.file} could not be read: ${live.error}`,
      unsupported: false,
    };
  }
  const entries = entriesToSync(live.value, spec);
  const shared = entries.filter((entry) => !mentionsHome(entry.value, context.home));
  const local = entries.filter((entry) => mentionsHome(entry.value, context.home));
  const sharedPath = `${agentRepoDir(target.agent)}/${spec.repoName}`;
  const machinePath = agentMachineSettingsPath(target.agent, context.host);
  const manifest = await agentManifestOrEmpty(repoRoot, target.agent);
  return {
    ok: true,
    actions: [
      ...(await writeRepoFile(
        repoRoot,
        sharedPath,
        await mergedRepoSettings(repoRoot, sharedPath, shared),
      )),
      ...(local.length === 0
        ? []
        : await writeRepoFile(
            repoRoot,
            machinePath,
            await mergedRepoSettings(repoRoot, machinePath, local),
          )),
      ...(await writeManifest(repoRoot, target, { ...manifest, settings: sharedPath })),
    ],
    question: `Copy ${target.short}'s settings from ${spec.file} into the config repo? Each machine sets them one key at a time.`,
  };
}

async function adoptMcp(
  repoRoot: string,
  target: AgentSyncTarget,
  item: ConfigItem,
): Promise<AgentAdoptPlan> {
  const spec = target.sync.mcp;
  const prefix = agentItemBase(target, 'mcp-server', '').id;
  const name = item.id.slice(prefix.length);
  const live = spec === null ? [] : ((await spec.read(target.dir)) ?? []);
  const server = live.find((entry) => entry.name === name);
  if (server === undefined) {
    return unsupported(item);
  }
  const extracted = extractMcpSecrets([server]);
  const manifest = await agentManifestOrEmpty(repoRoot, target.agent);
  const relative = manifest.mcp ?? `${agentRepoDir(target.agent)}/mcp.json`;
  const existing = await readJsonOrUndefined(repoFile(repoRoot, relative));
  const servers: Record<string, unknown> = {
    ...(isRecord(existing) && isRecord(existing['mcpServers']) ? existing['mcpServers'] : {}),
  };
  setOwn(servers, name, extracted.servers[name]);
  const secrets: Action[] = extracted.secrets.map((secret) => ({
    kind: 'save-secret',
    name: secret.name,
    value: secret.value,
  }));
  const keychain = secrets.length === 0 ? '' : ' Its secrets go in the keychain, not the repo.';
  return {
    ok: true,
    actions: [
      ...secrets,
      ...(await writeRepoFile(repoRoot, relative, stableJson({ mcpServers: servers }))),
      ...(await writeManifest(repoRoot, target, { ...manifest, mcp: relative })),
    ],
    question: `Copy the ${name} MCP server from ${target.short} into the config repo?${keychain}`,
  };
}

/** The plan that adopts one of an agent's items into agents/<id>/ of the repo. */
export async function planAgentAdopt(input: {
  readonly repoRoot: string;
  readonly target: AgentSyncTarget;
  readonly item: ConfigItem;
  readonly home: string;
  readonly host: string;
}): Promise<AgentAdoptPlan> {
  const { repoRoot, target, item } = input;
  if (item.kind === 'settings') {
    return adoptSettings(repoRoot, target, item, input);
  }
  if (item.kind === 'mcp-server') {
    return adoptMcp(repoRoot, target, item);
  }
  return adoptEntry(repoRoot, target, item);
}
