import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TokenBudgets } from './budgets.js';

let dir = '';
let file = '';
let changes = 0;
let errors: string[] = [];

function make(): TokenBudgets {
  return new TokenBudgets({
    file,
    onChange: (): void => {
      changes += 1;
    },
    report: (source, message): void => {
      errors.push(`${source}: ${message}`);
    },
  });
}

describe('TokenBudgets', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'overlord-budgets-'));
    file = path.join(dir, 'budgets.json');
    changes = 0;
    errors = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('has none before anything is saved', async () => {
    const budgets = make();
    await budgets.load();
    expect(budgets.tokens()).toStrictEqual({});
    expect(budgets.get('s1')).toBeNull();
    expect(budgets.warned('s1')).toBe(false);
    expect(errors).toStrictEqual([]);
  });

  it('saves budgets and warnings and keeps them across a reload', async () => {
    const budgets = make();
    await budgets.load();
    await budgets.set('s1', 500);
    await budgets.set('s2', 700);
    await budgets.markWarned('s1');
    await budgets.markWarned('missing');
    await budgets.idle();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toStrictEqual({
      version: 1,
      budgets: { s1: { tokens: 500, warned: true }, s2: { tokens: 700, warned: false } },
    });
    const reloaded = make();
    await reloaded.load();
    expect(reloaded.tokens()).toStrictEqual({ s1: 500, s2: 700 });
    expect(reloaded.warned('s1')).toBe(true);
    expect(changes).toBeGreaterThan(0);
  });

  it('warns again after a new budget, and forgets one that is cleared', async () => {
    const budgets = make();
    await budgets.set('s1', 500);
    await budgets.markWarned('s1');
    await budgets.set('s1', 900);
    expect(budgets.warned('s1')).toBe(false);
    await budgets.set('s1', null);
    expect(budgets.tokens()).toStrictEqual({});
  });

  it('reports a file it cannot read and starts empty', async () => {
    writeFileSync(file, '{ not json');
    const budgets = make();
    await budgets.load();
    expect(budgets.tokens()).toStrictEqual({});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^budgets: /u);
  });
});
