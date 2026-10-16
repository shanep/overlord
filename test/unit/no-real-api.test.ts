import childProcess, { execFile, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { DEAD_BASE_URL, isRealClaude, RealClaudeBlocked } from '../unit-setup.js';

async function startRealSdk(): Promise<void> {
  const run = query({ prompt: 'This must never send', options: { env: {}, cwd: os.tmpdir() } });
  await run.next();
}

describe('unit test environment', () => {
  it('points any real Claude CLI at a closed local port with a fake key', () => {
    expect(process.env['ANTHROPIC_BASE_URL']).toBe(DEAD_BASE_URL);
    expect(process.env['ANTHROPIC_API_KEY']).toBe('overlord-test-no-key');
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(process.env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
  });

  it('keeps Claude config out of the real home folder', () => {
    const dir = process.env['CLAUDE_CONFIG_DIR'] ?? '';
    expect(dir.startsWith(os.tmpdir())).toBe(true);
  });

  it('knows what a real Claude binary looks like', () => {
    expect(isRealClaude('claude')).toBe(true);
    expect(isRealClaude('/Users/me/.local/bin/claude')).toBe(true);
    expect(isRealClaude(String.raw`C:\bin\Claude.exe`)).toBe(true);
    expect(isRealClaude('claude.cmd')).toBe(true);
    expect(isRealClaude('/x/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/bin')).toBe(
      true,
    );
    expect(isRealClaude('node')).toBe(false);
    expect(isRealClaude('/repo/test/fake-claude/fake-claude.mjs')).toBe(false);
    expect(isRealClaude('git')).toBe(false);
  });

  it('blocks every child_process entry point from starting it', () => {
    expect(() => spawn('claude', ['-p', 'hi'])).toThrow(RealClaudeBlocked);
    expect(() => spawnSync('/opt/bin/claude', [])).toThrow(RealClaudeBlocked);
    expect(() => execFile('claude', ['--version'])).toThrow(RealClaudeBlocked);
    expect(() => childProcess.execFileSync('claude', [])).toThrow(RealClaudeBlocked);
    expect(() => childProcess.exec('claude -p hi')).toThrow(RealClaudeBlocked);
    expect(() => childProcess.execSync('  claude --help')).toThrow(RealClaudeBlocked);
  });

  it('still lets other programs run', () => {
    expect(spawnSync('node', ['-e', 'process.exit(3)']).status).toBe(3);
    expect(childProcess.execSync('node -e "process.stdout.write(String(1 + 1))"').toString()).toBe(
      '2',
    );
  });

  it('stops the real Agent SDK from starting its bundled CLI, even with an empty env', async () => {
    await expect(startRealSdk()).rejects.toThrow(RealClaudeBlocked);
  });
});
