import childProcess, { execFile, fork, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import {
  AGENT_SECRET_VARS,
  AGENT_VAR_PREFIXES,
  DEAD_BASE_URL,
  isRealClaude,
  RealAgentBlocked,
  realAgentInLine,
  realAgentOf,
  RealClaudeBlocked,
  REPO_GIT_VARS,
} from '../unit-setup.js';

const AGENT_HOMES = ['CODEX_HOME', 'COPILOT_HOME', 'GEMINI_CLI_HOME'];

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

  it('never lets git hook variables point tests at this repo', () => {
    expect(REPO_GIT_VARS).toContain('GIT_DIR');
    for (const name of REPO_GIT_VARS) {
      expect(process.env[name]).toBeUndefined();
    }
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

  it('clears the keys and logins the other agents read', () => {
    expect(AGENT_SECRET_VARS).toStrictEqual(
      expect.arrayContaining([
        'OPENAI_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'GH_TOKEN',
        'GITHUB_TOKEN',
      ]),
    );
    for (const name of AGENT_SECRET_VARS) {
      expect(process.env[name]).toBeUndefined();
    }
    const ours = new Set([...AGENT_HOMES, 'COPILOT_OFFLINE', 'COPILOT_AUTO_UPDATE']);
    const leftover = Object.keys(process.env).filter(
      (name) => AGENT_VAR_PREFIXES.some((prefix) => name.startsWith(prefix)) && !ours.has(name),
    );
    expect(leftover).toStrictEqual([]);
    expect(process.env['OPENAI_BASE_URL']).toBe(DEAD_BASE_URL);
    expect(process.env['COPILOT_OFFLINE']).toBe('true');
  });

  it('keeps Codex, Copilot and Gemini config out of the real home folder', () => {
    const dirs = AGENT_HOMES.map((name) => process.env[name] ?? '');
    expect(dirs.every((dir) => dir.startsWith(os.tmpdir()))).toBe(true);
    expect(new Set(dirs).size).toBe(AGENT_HOMES.length);
  });

  it('knows the other agent binaries by name, path and Windows suffix', () => {
    expect(realAgentOf('codex')).toBe('codex');
    expect(realAgentOf('/Users/me/.npm-packages/bin/codex')).toBe('codex');
    expect(realAgentOf(String.raw`C:\Users\me\AppData\Roaming\npm\codex.cmd`)).toBe('codex');
    expect(realAgentOf('copilot')).toBe('copilot');
    expect(realAgentOf('/opt/homebrew/bin/copilot')).toBe('copilot');
    expect(realAgentOf('Copilot.EXE')).toBe('copilot');
    expect(realAgentOf('gemini')).toBe('gemini');
    expect(realAgentOf('gemini.ps1')).toBe('gemini');
    expect(realAgentOf('agy')).toBe('agy');
    expect(realAgentOf('/usr/local/bin/agy.exe')).toBe('agy');
  });

  it('knows npx, npm exec, shell and node forms of the agent packages', () => {
    expect(realAgentOf('npx', ['-y', '@openai/codex', 'exec', 'hi'])).toBe('codex');
    expect(realAgentOf('npx', ['@openai/codex@0.50.0'])).toBe('codex');
    expect(realAgentOf('npx.cmd', ['--package=@github/copilot', 'copilot'])).toBe('copilot');
    expect(realAgentOf('npm', ['exec', '--', '@google/gemini-cli@latest'])).toBe('gemini');
    expect(realAgentOf('npm', ['x', '@anthropic-ai/claude-code'])).toBe('claude');
    expect(realAgentOf('pnpm', ['dlx', '@openai/codex'])).toBe('codex');
    expect(realAgentOf('npx', ['codex'])).toBe('codex');
    expect(realAgentOf('node', ['/g/node_modules/@openai/codex/bin/codex.js'])).toBe('codex');
    expect(realAgentOf('/g/node_modules/@google/gemini-cli/dist/index.js')).toBe('gemini');
    expect(realAgentOf('sh', ['-c', 'cd /tmp && codex exec hi'])).toBe('codex');
    expect(realAgentOf('env', ['-i', 'FOO=1', 'copilot', '-p', 'hi'])).toBe('copilot');
    expect(realAgentInLine('GEMINI_API_KEY=x gemini -p hi')).toBe('gemini');
    expect(realAgentInLine('echo hi; "/opt/bin/agy" run')).toBe('agy');
    expect(realAgentInLine('npm exec -- @github/copilot --help')).toBe('copilot');
  });

  it('leaves other programs and the fake agents alone', () => {
    expect(realAgentOf('node', ['/repo/test/fake-claude/fake-claude.mjs'])).toBeNull();
    expect(realAgentOf('/repo/test/fake-agents/codex/codex')).toBeNull();
    expect(realAgentOf('npx', ['vitest', 'related', 'src/core/agents/codex.ts'])).toBeNull();
    expect(realAgentOf('npm', ['exec', '--', 'prettier', '--check', '.'])).toBeNull();
    expect(realAgentOf('npx', ['@github/copilot-language-server'])).toBeNull();
    expect(realAgentOf('git', ['commit', '-m', 'Mention codex and gemini'])).toBeNull();
    expect(realAgentOf('codex-helper')).toBeNull();
    expect(realAgentOf('env', [])).toBeNull();
    expect(realAgentOf('bash', ['script.sh'])).toBeNull();
    expect(realAgentInLine('node -e "1" && git status')).toBeNull();
    expect(realAgentInLine('  ')).toBeNull();
  });

  it('blocks every child_process entry point from starting another agent', () => {
    expect(() => spawn('codex', ['exec', 'hi'])).toThrow(RealAgentBlocked);
    expect(() => spawn('codex exec hi', { shell: true })).toThrow(/real Codex CLI/u);
    expect(() => spawnSync('/Users/me/.npm-packages/bin/copilot', ['-p', 'hi'])).toThrow(
      /real Copilot CLI/u,
    );
    expect(() => execFile('gemini.cmd', ['-p', 'hi'])).toThrow(/real Gemini CLI/u);
    expect(() => childProcess.execFileSync('agy', [])).toThrow(/real Antigravity CLI/u);
    expect(() => childProcess.exec('npx -y @openai/codex exec hi')).toThrow(RealAgentBlocked);
    expect(() => childProcess.execSync('npm exec -- @google/gemini-cli -p hi')).toThrow(
      RealAgentBlocked,
    );
    expect(() => spawn('npx', ['--yes', '@github/copilot@latest'])).toThrow(RealAgentBlocked);
    expect(() => spawnSync('sh', ['-c', 'COPILOT_ALLOW_ALL=1 copilot -p hi'])).toThrow(
      RealAgentBlocked,
    );
    expect(() => fork('/g/node_modules/@openai/codex/bin/codex.js')).toThrow(RealAgentBlocked);
  });

  it('names the agent it blocked, and still blocks Claude as RealClaudeBlocked', () => {
    let caught: unknown = null;
    try {
      spawnSync('codex', []);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RealAgentBlocked);
    expect(caught instanceof RealAgentBlocked ? caught.agent : null).toBe('codex');
    expect(() => spawn('npx', ['@anthropic-ai/claude-code'])).toThrow(RealClaudeBlocked);
    expect(new RealClaudeBlocked('claude')).toBeInstanceOf(RealAgentBlocked);
  });
});
