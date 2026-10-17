// The small steps every apply plan is built from: link, copy, mkdir and
// backup, plus the MCP config comparison. plan.ts and agent-plan.ts share them.

import { readlink } from 'node:fs/promises';
import path from 'node:path';

import type { Action } from './actions.js';
import { hashPath, lstatOrNull, pathExists, statOrNull } from './files.js';
import { isArray, isRecord, jsonEqual } from './json.js';
import { placeholdersInText } from './secrets.js';

/** True when `target` is a symlink that points at `source`. */
export async function linksTo(target: string, source: string): Promise<boolean> {
  const info = await lstatOrNull(target);
  if (info?.isSymbolicLink() !== true) {
    return false;
  }
  const pointed = path.resolve(path.dirname(target), await readlink(target));
  return pointed === path.resolve(source);
}

/** mkdir for a missing parent and a backup when something is already there. */
export async function prepareTarget(target: string): Promise<Action[]> {
  const actions: Action[] = [];
  const parent = path.dirname(target);
  if ((await statOrNull(parent)) === null) {
    actions.push({ kind: 'mkdir', path: parent });
  }
  if (await pathExists(target)) {
    actions.push({ kind: 'backup', path: target });
  }
  return actions;
}

export async function planLink(source: string, target: string): Promise<Action[]> {
  if (await linksTo(target, source)) {
    return [];
  }
  return [...(await prepareTarget(target)), { kind: 'link', source, target }];
}

export async function planCopy(source: string, target: string): Promise<Action[]> {
  const info = await lstatOrNull(target);
  const isLink = info?.isSymbolicLink() === true;
  if (info !== null && !isLink && (await hashPath(target)) === (await hashPath(source))) {
    return [];
  }
  return [...(await prepareTarget(target)), { kind: 'copy', source, target }];
}

/**
 * Whether the live server config already matches the repo's. Keys the CLI
 * adds on its own are ignored, and a string holding a placeholder matches any
 * string, since the secret itself is never read back for comparison.
 */
export function matchesTemplate(template: unknown, actual: unknown): boolean {
  if (typeof template === 'string') {
    return placeholdersInText(template).length > 0
      ? typeof actual === 'string'
      : template === actual;
  }
  if (isArray(template)) {
    return (
      isArray(actual) &&
      actual.length === template.length &&
      template.every((entry, index) => matchesTemplate(entry, actual[index]))
    );
  }
  if (isRecord(template)) {
    return (
      isRecord(actual) &&
      Object.entries(template).every(([key, value]) => matchesTemplate(value, actual[key]))
    );
  }
  return jsonEqual(template, actual);
}
