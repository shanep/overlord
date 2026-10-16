import { describe, expect, it } from 'vitest';

import { parseMcpList, statusFrom } from './mcp-list.js';

const OUTPUT = [
  'Checking MCP server health…',
  '',
  'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected',
  'jupyter: uvx jupyter-mcp-server - ✗ Failed to connect',
  'sentry: https://mcp.sentry.dev/mcp (HTTP) - ⚠ Needs authentication',
  'team: npx -y team-server - run - ⏸ Pending approval',
  'old: node old.js - ○ Disabled',
  'odd: node odd.js - ? Sleeping',
].join('\n');

describe('statusFrom', () => {
  it('reads each status by its words', () => {
    expect(statusFrom('Connected')).toBe('ok');
    expect(statusFrom('Needs authentication')).toBe('needs-auth');
    expect(statusFrom('Failed to connect')).toBe('failed');
    expect(statusFrom('Not connected')).toBe('failed');
    expect(statusFrom('Error: boom')).toBe('failed');
    expect(statusFrom('Pending approval')).toBe('pending');
    expect(statusFrom('disabled')).toBe('disabled');
    expect(statusFrom('Not configured')).toBe('missing');
    expect(statusFrom('Connected · tools fetch failed')).toBe('failed');
    expect(statusFrom('Connection error')).toBe('failed');
    expect(statusFrom('Sleeping')).toBe('unknown');
  });
});

describe('parseMcpList', () => {
  it('turns each server line into a connector', () => {
    expect(parseMcpList(OUTPUT)).toStrictEqual([
      {
        id: 'claude.ai:claude.ai Gmail',
        name: 'claude.ai Gmail',
        kind: 'claude.ai',
        target: 'https://gmailmcp.googleapis.com/mcp/v1',
        status: 'ok',
        detail: 'Connected.',
        fix: null,
      },
      {
        id: 'mcp:jupyter',
        name: 'jupyter',
        kind: 'mcp',
        target: 'uvx jupyter-mcp-server',
        status: 'failed',
        detail: 'Claude Code could not connect to it.',
        fix: null,
      },
      {
        id: 'mcp:sentry',
        name: 'sentry',
        kind: 'mcp',
        target: 'https://mcp.sentry.dev/mcp (HTTP)',
        status: 'needs-auth',
        detail: 'Needs a sign in before a session can use it.',
        fix: 'sign-in',
      },
      {
        id: 'mcp:team',
        name: 'team',
        kind: 'mcp',
        target: 'npx -y team-server - run',
        status: 'pending',
        detail:
          'Waiting for you to approve this project .mcp.json server in a Claude Code session.',
        fix: null,
      },
      {
        id: 'mcp:old',
        name: 'old',
        kind: 'mcp',
        target: 'node old.js',
        status: 'disabled',
        detail: 'Turned off for this project.',
        fix: null,
      },
      {
        id: 'mcp:odd',
        name: 'odd',
        kind: 'mcp',
        target: 'node odd.js',
        status: 'unknown',
        detail: 'Claude Code reported a status Overlord does not know. It said: Sleeping',
        fix: null,
      },
    ]);
  });

  it('finds nothing in the note printed when no server is set up', () => {
    expect(
      parseMcpList('No MCP servers configured. Use `claude mcp add` to add a server.\r\n'),
    ).toStrictEqual([]);
    expect(parseMcpList(': x - ✔ Connected')).toStrictEqual([]);
  });
});
