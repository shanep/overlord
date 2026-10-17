// The approvals `codex app-server` asks for, as permission inbox questions,
// and the answers it takes back. A command or file change takes accept,
// acceptForSession, decline or cancel, which are the inbox's allow, allow for
// the session, deny, and deny and stop the turn. A permissions request takes
// the grant itself, for the turn or the session.

import { z } from 'zod';

import type { PermissionChoice } from '../../../shared/model.js';
import type { ToolPermissionResult } from '../shared/runtime.js';

import type { CodexTranslator } from './app-server.js';
import { shellScript } from './items.js';

const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
const FILE_APPROVAL = 'item/fileChange/requestApproval';
const PERMISSIONS_APPROVAL = 'item/permissions/requestApproval';

/** One question for the permission inbox. */
export interface ApprovalAsk {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  /** The item the approval is about, which the feed shows as the tool call. */
  readonly toolUseId: string;
  readonly choices: readonly PermissionChoice[];
}

/** Codex's word for each answer the inbox offers. */
const CHOICES: Readonly<Record<string, PermissionChoice>> = {
  accept: 'allow',
  acceptForSession: 'allow_session',
  decline: 'deny',
  cancel: 'cancel',
};

/** What a file change always offers, since its request lists none. */
const ALL_CHOICES: readonly PermissionChoice[] = ['allow', 'allow_session', 'deny', 'cancel'];

/**
 * The answers availableDecisions lists, as the inbox's choices. Deny is always
 * there: 0.163.0 takes decline even when it leaves it off the list. Answers
 * with a policy amendment have no inbox choice yet, so they are left out.
 */
function offered(decisions: readonly unknown[] | null | undefined): readonly PermissionChoice[] {
  if (decisions === null || decisions === undefined) {
    return ALL_CHOICES;
  }
  const named = new Set(
    decisions.flatMap((entry) => {
      const choice = typeof entry === 'string' ? CHOICES[entry] : undefined;
      return choice === undefined ? [] : [choice];
    }),
  );
  return ALL_CHOICES.filter((choice) => choice === 'deny' || named.has(choice));
}

const commandSchema = z.object({
  itemId: z.string(),
  command: z.string().nullish(),
  cwd: z.string().nullish(),
  reason: z.string().nullish(),
  availableDecisions: z.array(z.unknown()).nullish(),
});

const fileSchema = z.object({
  itemId: z.string(),
  reason: z.string().nullish(),
  grantRoot: z.string().nullish(),
});

const permissionsSchema = z.object({
  itemId: z.string(),
  cwd: z.string().nullish(),
  reason: z.string().nullish(),
  permissions: z.object({ network: z.unknown(), fileSystem: z.unknown() }).partial(),
});

/** Leaves out the keys whose value is null or missing. */
function present(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value !== undefined),
  );
}

function commandAsk(params: unknown, translator: CodexTranslator): ApprovalAsk | null {
  const parsed = commandSchema.safeParse(params);
  if (!parsed.success) {
    return null;
  }
  const { itemId, command, cwd, reason, availableDecisions } = parsed.data;
  const known = translator.tool(itemId)?.input ?? {};
  const asked = present({
    command: command === null || command === undefined ? undefined : shellScript(command),
    cwd,
    reason,
  });
  return {
    toolName: 'exec_command',
    input: { ...known, ...asked },
    toolUseId: itemId,
    choices: offered(availableDecisions),
  };
}

function fileAsk(params: unknown, translator: CodexTranslator): ApprovalAsk | null {
  const parsed = fileSchema.safeParse(params);
  if (!parsed.success) {
    return null;
  }
  const { itemId, reason, grantRoot } = parsed.data;
  const known = translator.tool(itemId)?.input ?? {};
  return {
    toolName: 'apply_patch',
    input: { ...known, ...present({ reason, grantRoot }) },
    toolUseId: itemId,
    choices: ALL_CHOICES,
  };
}

function permissionsAsk(params: unknown): ApprovalAsk | null {
  const parsed = permissionsSchema.safeParse(params);
  if (!parsed.success) {
    return null;
  }
  const { itemId, cwd, reason, permissions } = parsed.data;
  return {
    toolName: 'request_permissions',
    input: present({ permissions: present(permissions), cwd, reason }),
    toolUseId: itemId,
    // A grant can last the turn or the session. Denying grants nothing and the turn goes on.
    choices: ['allow', 'allow_session', 'deny'],
  };
}

/** What the inbox shows for an approval, or null for a request that is not one Overlord answers. */
export function approvalAsk(
  method: string,
  params: unknown,
  translator: CodexTranslator,
): ApprovalAsk | null {
  switch (method) {
    case COMMAND_APPROVAL: {
      return commandAsk(params, translator);
    }
    case FILE_APPROVAL: {
      return fileAsk(params, translator);
    }
    case PERMISSIONS_APPROVAL: {
      return permissionsAsk(params);
    }
    default: {
      return null;
    }
  }
}

/** The inbox's answer in Codex's words: once or for the session, decline, or cancel the turn. */
function decision(
  result: ToolPermissionResult,
): 'accept' | 'acceptForSession' | 'decline' | 'cancel' {
  if (result.behavior === 'allow') {
    return result.scope === 'session' ? 'acceptForSession' : 'accept';
  }
  return result.interrupt === true ? 'cancel' : 'decline';
}

/** The reply to an approval request, given the inbox's answer. */
export function approvalReply(
  method: string,
  params: unknown,
  result: ToolPermissionResult,
): unknown {
  if (method !== PERMISSIONS_APPROVAL) {
    return { decision: decision(result) };
  }
  const parsed = permissionsSchema.safeParse(params);
  const asked = parsed.success ? present(parsed.data.permissions) : {};
  if (result.behavior === 'deny') {
    return { permissions: {}, scope: 'turn' };
  }
  return { permissions: asked, scope: result.scope === 'session' ? 'session' : 'turn' };
}
