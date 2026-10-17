// The approvals `codex app-server` asks for, as permission inbox questions,
// and the answers it takes back. A command or file change offers accept,
// acceptForSession, decline and cancel. A permissions request takes the
// grant itself.

import { z } from 'zod';

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
}

const commandSchema = z.object({
  itemId: z.string(),
  command: z.string().nullish(),
  cwd: z.string().nullish(),
  reason: z.string().nullish(),
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
  const { itemId, command, cwd, reason } = parsed.data;
  const known = translator.tool(itemId)?.input ?? {};
  const asked = present({
    command: command === null || command === undefined ? undefined : shellScript(command),
    cwd,
    reason,
  });
  return { toolName: 'exec_command', input: { ...known, ...asked }, toolUseId: itemId };
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

/**
 * accept or decline for now. Workstream N1 is adding allow for the session
 * and cancel the turn to PermissionDecision. Once ToolPermissionResult
 * carries them, map them to acceptForSession and cancel here.
 */
function decision(result: ToolPermissionResult): 'accept' | 'decline' {
  return result.behavior === 'allow' ? 'accept' : 'decline';
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
  // A grant for this turn only, which is the narrowest scope Codex takes.
  const parsed = permissionsSchema.safeParse(params);
  const asked = parsed.success ? present(parsed.data.permissions) : {};
  return { permissions: result.behavior === 'allow' ? asked : {}, scope: 'turn' };
}
