// What a transcript tells us about the context of one agent: memory files,
// system prompt, skills, agent types, MCP instructions, deferred tools and the
// environment block. Other modules fill in skipped candidates and weights.

import { Buffer } from 'node:buffer';

import type {
  ContextSnapshot,
  LoadedInstruction,
  LoadReason,
  MemoryTier,
  SkillEntry,
} from '../../shared/model.js';

import type { Attachment } from './schemas.js';
import { displayValue } from './text.js';

const TIERS: readonly MemoryTier[] = ['Managed', 'User', 'Project', 'Local', 'AutoMem'];
const REASONS: readonly LoadReason[] = [
  'session_start',
  'nested_traversal',
  'path_glob_match',
  'include',
  'compact',
];

function toTier(value: string): MemoryTier | null {
  return TIERS.find((tier) => tier === value) ?? null;
}

function toReason(value: string | null | undefined): LoadReason {
  return REASONS.find((reason) => reason === value) ?? 'session_start';
}

type SkillSource = SkillEntry['source'];

const SOURCE_PREFIXES: ReadonlyMap<string, SkillSource> = new Map([
  ['userSettings', 'user'],
  ['projectSettings', 'project'],
  ['localSettings', 'project'],
  ['policySettings', 'managed'],
  ['plugin', 'plugin'],
]);
const SOURCE_PREFIX = /^([^:/]+):/u;

/** Invoked skill paths look like "userSettings:writing-voice" or an absolute path. */
export function skillSource(name: string, location: string | null): SkillSource {
  if (location !== null) {
    const prefix = SOURCE_PREFIX.exec(location)?.[1];
    const mapped = prefix === undefined ? undefined : SOURCE_PREFIXES.get(prefix);
    if (mapped !== undefined) {
      return mapped;
    }
    if (location.includes('/skills/synced/')) {
      return 'claude-ai';
    }
    if (location.includes('/plugins/')) {
      return 'plugin';
    }
  }
  return name.includes(':') ? 'plugin' : 'unknown';
}

/** The description length for one skill from the "- name: description" listing text. */
export function listedDescriptionChars(listing: string, name: string): number {
  const head = `- ${name}: `;
  for (const line of listing.split('\n')) {
    if (line.startsWith(head)) {
      return line.length - head.length;
    }
  }
  return 0;
}

/** An MCP instructions block starts with a "## name" header line we do not need. */
export function stripMcpHeader(block: string, name: string): string {
  const header = `## ${name}\n`;
  return block.startsWith(header) ? block.slice(header.length) : block;
}

type ContextAttachment = Exclude<Attachment, { type: 'queued_command' }>;

const LIST_TYPES: ReadonlySet<string> = new Set([
  'skill_listing',
  'invoked_skills',
  'mcp_instructions_delta',
  'deferred_tools_delta',
  'agent_listing_delta',
]);

type ListAttachment = Extract<
  ContextAttachment,
  {
    type:
      | 'skill_listing'
      | 'invoked_skills'
      | 'mcp_instructions_delta'
      | 'deferred_tools_delta'
      | 'agent_listing_delta';
  }
>;

function isListDelta(attachment: ContextAttachment): attachment is ListAttachment {
  return LIST_TYPES.has(attachment.type);
}

function applySetDelta(
  target: Set<string>,
  added: readonly string[],
  removed: readonly string[],
): void {
  for (const name of removed) {
    target.delete(name);
  }
  for (const name of added) {
    target.add(name);
  }
}

interface MutableSkill {
  name: string;
  source: SkillSource;
  path: string | null;
  listed: boolean;
  invoked: boolean;
  descriptionChars: number;
}

export interface ContextIds {
  readonly sessionId: string;
  readonly agentId: string;
}

export class ContextTracker {
  private at: number | null = null;
  private systemPrompt: readonly string[] | null = null;
  private model: string | null = null;
  private readonly loaded = new Map<string, LoadedInstruction>();
  private readonly skills = new Map<string, MutableSkill>();
  private readonly agentTypes = new Set<string>();
  private readonly mcpServers = new Map<string, string>();
  private readonly deferredTools = new Set<string>();
  private environment: Readonly<Record<string, string>> = {};

  /** Apply one attachment. Returns true when it changed the context. */
  apply(attachment: Attachment, at: number | null): boolean {
    if (attachment.type === 'queued_command') {
      return false;
    }
    if (at !== null) {
      this.at = at;
    }
    this.applyContext(attachment);
    return true;
  }

  snapshot(ids: ContextIds, fallbackModel: string | null): ContextSnapshot {
    return {
      sessionId: ids.sessionId,
      agentId: ids.agentId,
      at: this.at ?? 0,
      systemPrompt: this.systemPrompt,
      model: this.model ?? fallbackModel,
      loaded: [...this.loaded.values()],
      skipped: [],
      skills: [...this.skills.values()].map((skill) => ({ ...skill })),
      agentTypes: [...this.agentTypes],
      mcpServers: [...this.mcpServers].map(([name, instructions]) => ({ name, instructions })),
      deferredTools: [...this.deferredTools],
      environment: this.environment,
      weights: [],
    };
  }

  private applyContext(attachment: ContextAttachment): void {
    if (isListDelta(attachment)) {
      this.applyListDelta(attachment);
      return;
    }
    switch (attachment.type) {
      case 'instructions': {
        this.applyInstructions(attachment);
        break;
      }
      case 'nested_memory': {
        this.applyNestedMemory(attachment);
        break;
      }
      case 'prompt_snapshot': {
        this.systemPrompt = attachment.systemPrompt;
        break;
      }
      case 'environment': {
        this.environment = Object.fromEntries(
          Object.entries(attachment.snapshot).map(([key, value]) => [key, displayValue(value)]),
        );
        break;
      }
      case 'model': {
        this.model = attachment.identity.modelId;
        break;
      }
    }
  }

  private applyListDelta(attachment: ListAttachment): void {
    switch (attachment.type) {
      case 'skill_listing': {
        this.applySkillListing(attachment.names, attachment.content);
        break;
      }
      case 'invoked_skills': {
        for (const skill of attachment.skills) {
          this.applyInvokedSkill(skill.name, skill.path ?? null);
        }
        break;
      }
      case 'mcp_instructions_delta': {
        this.applyMcpDelta(attachment);
        break;
      }
      case 'deferred_tools_delta': {
        applySetDelta(this.deferredTools, attachment.addedNames, attachment.removedNames);
        break;
      }
      case 'agent_listing_delta': {
        applySetDelta(this.agentTypes, attachment.addedTypes, attachment.removedTypes);
        break;
      }
    }
  }

  private applyInstructions(attachment: Extract<Attachment, { type: 'instructions' }>): void {
    for (const removed of attachment.removed) {
      this.loaded.delete(removed);
    }
    const reason = toReason(attachment.reason);
    for (const file of attachment.files) {
      const tier = toTier(file.type);
      if (tier !== null) {
        this.loaded.set(file.path, {
          path: file.path,
          tier,
          reason,
          triggerPath: null,
          parentPath: null,
          globs: [],
          bytes: Buffer.byteLength(file.content),
          differsFromDisk: null,
          loadedAt: this.at,
        });
      }
    }
  }

  private applyNestedMemory(attachment: Extract<Attachment, { type: 'nested_memory' }>): void {
    const tier = toTier(attachment.content.type);
    if (tier === null) {
      return;
    }
    const filePath = attachment.content.path ?? attachment.path;
    this.loaded.set(filePath, {
      path: filePath,
      tier,
      reason: 'nested_traversal',
      triggerPath: null,
      parentPath: null,
      globs: [],
      bytes: Buffer.byteLength(attachment.content.content),
      differsFromDisk: attachment.content.contentDiffersFromDisk ?? null,
      loadedAt: this.at,
    });
  }

  private skill(name: string): MutableSkill {
    const existing = this.skills.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const created: MutableSkill = {
      name,
      source: skillSource(name, null),
      path: null,
      listed: false,
      invoked: false,
      descriptionChars: 0,
    };
    this.skills.set(name, created);
    return created;
  }

  private applySkillListing(names: readonly string[], listing: string): void {
    for (const name of names) {
      const entry = this.skill(name);
      entry.listed = true;
      entry.descriptionChars = listedDescriptionChars(listing, name);
    }
  }

  private applyInvokedSkill(name: string, location: string | null): void {
    const entry = this.skill(name);
    entry.invoked = true;
    entry.source = skillSource(name, location);
    entry.path = location?.startsWith('/') === true ? location : null;
  }

  private applyMcpDelta(attachment: Extract<Attachment, { type: 'mcp_instructions_delta' }>): void {
    for (const name of attachment.removedNames) {
      this.mcpServers.delete(name);
    }
    for (const [index, name] of attachment.addedNames.entries()) {
      this.mcpServers.set(name, stripMcpHeader(attachment.addedBlocks[index] ?? '', name));
    }
  }
}
