import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentNode, PermissionRequest } from '../../shared/model.js';
import type { AutoApproveRule } from '../../shared/protocol.js';
import { EventBus } from '../bus.js';

import type { AuditEntry } from './audit.js';
import type { InstructionLoadedEvent } from './mapping.js';
import type { HookEvent, HookServerOptions } from './server.js';
import { DEFAULT_HOLD_MS, HookServer, prepareSocketPath, socketPath } from './server.js';

class TestClient {
  private readonly lines: string[] = [];
  private readonly waiters: ((line: string) => void)[] = [];
  private buffer = '';
  readonly closed: Promise<void>;

  constructor(readonly socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      const parts = this.buffer.split('\n');
      this.buffer = parts.pop() ?? '';
      for (const part of parts) {
        const waiter = this.waiters.shift();
        if (waiter === undefined) {
          this.lines.push(part);
        } else {
          waiter(part);
        }
      }
    });
    this.closed = new Promise((resolve) => {
      socket.on('close', () => {
        resolve();
      });
    });
  }

  static async open(file: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(file, () => {
        resolve(new TestClient(socket));
      });
      socket.once('error', reject);
    });
  }

  send(id: string, event: unknown): void {
    this.socket.write(`${JSON.stringify({ id, event })}\n`);
  }

  async next(): Promise<unknown> {
    const queued = this.lines.shift();
    if (queued !== undefined) {
      return JSON.parse(queued);
    }
    return new Promise((resolve) => {
      this.waiters.push((line) => {
        resolve(JSON.parse(line));
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

async function modeOf(target: string): Promise<number> {
  const info = await stat(target);
  return info.mode & 0o777;
}

const base = { session_id: 'sess', cwd: '/w', transcript_path: '/t.jsonl' };

function permissionEvent(
  input: Readonly<Record<string, unknown>>,
  toolName = 'Bash',
): Readonly<Record<string, unknown>> {
  return { ...base, hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: input };
}

const allowLs: AutoApproveRule = {
  id: 'allow-ls',
  enabled: true,
  behavior: 'allow',
  tool: 'Bash',
  pattern: 'ls*',
  description: 'listing is fine',
};

const denyRm: AutoApproveRule = {
  id: 'deny-rm',
  enabled: true,
  behavior: 'deny',
  tool: 'Bash',
  pattern: 'rm *',
  description: 'no deletes',
};

function sendEvent(to: unknown, toolName = 'SendMessage'): Readonly<Record<string, unknown>> {
  return {
    ...base,
    agent_id: 'agent-7',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { to, message: 'synthetic text', summary: 'note' },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  expect(check()).toBe(true);
}

describe('socketPath', () => {
  it('is re-exported from the server module', () => {
    expect(socketPath({ configDir: '/c' }, 'linux')).toBe('/c/overlord/hook.sock');
  });
});

describe('prepareSocketPath', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-prep-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('does nothing for Windows pipes', async () => {
    const file = path.join(dir, 'missing', 'hook.sock');
    await prepareSocketPath(file, 'win32');
    await expect(access(path.dirname(file))).rejects.toThrow();
  });

  it('creates a private directory and removes a stale file', async () => {
    const file = path.join(dir, 'overlord', 'hook.sock');
    await prepareSocketPath(file, 'darwin');
    expect(await modeOf(path.dirname(file))).toBe(0o700);
    await writeFile(file, 'stale');
    await prepareSocketPath(file, 'linux');
    await expect(access(file)).rejects.toThrow();
  });
});

describe('HookServer', () => {
  let dir: string;
  let file: string;
  let bus: EventBus;
  let servers: HookServer[];
  let clients: TestClient[];
  let clock: number;
  let ids: number;

  async function startServer(options: Partial<HookServerOptions> = {}): Promise<HookServer> {
    const server = new HookServer({
      socketPath: file,
      bus,
      now: (): number => {
        clock += 1;
        return clock;
      },
      newId: (): string => {
        ids += 1;
        return `perm-${String(ids)}`;
      },
      ...options,
    });
    servers.push(server);
    await server.start();
    return server;
  }

  async function client(): Promise<TestClient> {
    const opened = await TestClient.open(file);
    clients.push(opened);
    return opened;
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-hs-'));
    file = path.join(dir, 'overlord', 'hook.sock');
    bus = new EventBus();
    servers = [];
    clients = [];
    clock = 1000;
    ids = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const opened of clients) {
      opened.close();
    }
    await Promise.all(servers.map(async (server) => server.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  it('holds permission requests for ten minutes by default', () => {
    expect(DEFAULT_HOLD_MS).toBe(600_000);
  });

  it('listens on the socket path inside a private directory', async () => {
    const server = await startServer();
    expect(server.socketPath).toBe(file);
    const info = await stat(file);
    expect(info.isSocket()).toBe(true);
    expect(await modeOf(path.dirname(file))).toBe(0o700);
  });

  it('replaces a stale socket file', async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'left over');
    await startServer();
    const opened = await client();
    opened.send('m1', { ...base, hook_event_name: 'Stop' });
    expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
  });

  it('refuses to start while another server is listening', async () => {
    await startServer();
    const second = new HookServer({ socketPath: file, bus });
    await expect(second.start()).rejects.toThrow(
      `another Overlord hook server is already listening on ${file}`,
    );
  });

  it('rejects when the socket cannot be bound', async () => {
    const server = new HookServer({ socketPath: dir, bus, platform: 'win32' });
    await expect(server.start()).rejects.toThrow();
    await server.stop();
  });

  it('answers other events at once and reports them to onEvent', async () => {
    const server = await startServer();
    const events: HookEvent[] = [];
    const off = server.onEvent((event) => events.push(event));
    const opened = await client();
    opened.send('m1', {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: {},
    });
    expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
    opened.send('m2', { ...base, hook_event_name: 'TaskCreated', task_id: 't' });
    expect(await opened.next()).toStrictEqual({ id: 'm2', output: {} });
    expect(events).toHaveLength(2);
    expect(events[0]?.receivedAt).toBe(1001);
    expect(events[0]?.hook.known).toBe(true);
    expect(events[0]?.hook.payload.hook_event_name).toBe('PreToolUse');
    expect(events[1]?.hook).toStrictEqual({
      known: false,
      payload: { ...base, hook_event_name: 'TaskCreated', task_id: 't' },
    });
    off();
    opened.send('m3', { ...base, hook_event_name: 'Stop' });
    await opened.next();
    expect(events).toHaveLength(2);
  });

  describe('SessionStart', () => {
    const start = { ...base, hook_event_name: 'SessionStart', source: 'startup' };

    it('adds the session note to the context', async () => {
      await startServer({ sessionContext: () => 'check the connectors' });
      const opened = await client();
      opened.send('m1', start);
      expect(await opened.next()).toStrictEqual({
        id: 'm1',
        output: {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: 'check the connectors',
          },
        },
      });
    });

    it('answers with nothing when there is no note', async () => {
      await startServer({ sessionContext: (): null => null });
      const opened = await client();
      opened.send('m1', start);
      expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
      await startServer({ socketPath: path.join(dir, 'other.sock') });
      const other = await TestClient.open(path.join(dir, 'other.sock'));
      clients.push(other);
      other.send('m2', start);
      expect(await other.next()).toStrictEqual({ id: 'm2', output: {} });
    });

    it('reports a note that throws and answers with nothing', async () => {
      await startServer({
        sessionContext: () => {
          throw new Error('no cache');
        },
      });
      const errors: string[] = [];
      bus.on('source.error', (error) => errors.push(error.message));
      const opened = await client();
      opened.send('m1', start);
      expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
      expect(errors).toStrictEqual(['session note failed: no cache']);
    });
  });

  it('reports InstructionsLoaded through onInstructionLoaded', async () => {
    const server = await startServer();
    const loaded: InstructionLoadedEvent[] = [];
    const off = server.onInstructionLoaded((event) => loaded.push(event));
    const opened = await client();
    const event = {
      ...base,
      hook_event_name: 'InstructionsLoaded',
      file_path: '/w/CLAUDE.md',
      memory_type: 'Project',
      load_reason: 'session_start',
    };
    opened.send('m1', event);
    expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.sessionId).toBe('sess');
    expect(loaded[0]?.instruction.path).toBe('/w/CLAUDE.md');
    expect(loaded[0]?.instruction.loadedAt).toBe(1002);
    off();
    opened.send('m2', event);
    await opened.next();
    expect(loaded).toHaveLength(1);
  });

  it('publishes subagent state on the bus', async () => {
    await startServer();
    const agents: AgentNode[] = [];
    bus.on('agent.upserted', (agent) => agents.push(agent));
    const opened = await client();
    const start = {
      ...base,
      hook_event_name: 'SubagentStart',
      agent_id: 'a1',
      agent_type: 'Explore',
    };
    opened.send('m1', start);
    await opened.next();
    opened.send('m2', start);
    await opened.next();
    opened.send('m3', {
      ...start,
      hook_event_name: 'SubagentStop',
      agent_transcript_path: '/a1.jsonl',
    });
    await opened.next();
    opened.send('m4', { ...start, agent_id: 'a2', hook_event_name: 'SubagentStop' });
    await opened.next();
    expect(
      agents.map((agent) => [agent.id, agent.state, agent.startedAt, agent.endedAt]),
    ).toStrictEqual([
      ['a1', 'running', 1002, null],
      ['a1', 'running', 1002, null],
      ['a1', 'done', 1002, 1006],
      ['a2', 'done', 1008, 1008],
    ]);
    expect(agents[2]?.transcriptPath).toBe('/a1.jsonl');
    expect(agents[0]?.sessionId).toBe('sess');
  });

  it('starts a fresh start time after an agent stops', async () => {
    await startServer();
    const agents: AgentNode[] = [];
    bus.on('agent.upserted', (agent) => agents.push(agent));
    const opened = await client();
    const start = { ...base, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Plan' };
    for (const [index, event] of [
      start,
      { ...start, hook_event_name: 'SubagentStop' },
      start,
    ].entries()) {
      opened.send(`m${String(index)}`, event);
      await opened.next();
    }
    expect(agents.map((agent) => agent.startedAt)).toStrictEqual([1002, 1002, 1006]);
  });

  it('reports a message that is not a request and keeps the connection', async () => {
    await startServer();
    const errors: string[] = [];
    bus.on('source.error', (error) => errors.push(`${error.source}: ${error.message}`));
    const opened = await client();
    opened.socket.write('garbage\n');
    opened.send('m1', { ...base, hook_event_name: 'Stop' });
    expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
    expect(errors).toStrictEqual(['hooks: hook script sent a message that is not a request']);
  });

  it('answers an invalid payload with an empty output and reports it', async () => {
    await startServer();
    const errors: string[] = [];
    bus.on('source.error', (error) => errors.push(error.message));
    const opened = await client();
    opened.send('m1', { hook_event_name: 'Stop' });
    expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^invalid hook payload: .*session_id/su);
  });

  it('drops a connection that sends an oversized message', async () => {
    await startServer({ maxLineBytes: 64 });
    const errors: string[] = [];
    bus.on('source.error', (error) => errors.push(error.message));
    const opened = await client();
    opened.socket.write('x'.repeat(200));
    await opened.closed;
    expect(errors).toStrictEqual(['hook message longer than 64 bytes']);
  });

  it('keeps going when a listener throws', async () => {
    const server = await startServer();
    const errors: string[] = [];
    bus.on('source.error', (error) => errors.push(error.message));
    bus.on('source.error', () => {
      throw new Error('error listener broke');
    });
    server.onEvent(() => {
      throw new Error('boom');
    });
    server.onInstructionLoaded(() => {
      // Covers a listener that throws something other than an Error.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain';
    });
    const opened = await client();
    opened.send('m1', {
      ...base,
      hook_event_name: 'InstructionsLoaded',
      file_path: '/f',
      memory_type: 'User',
      load_reason: 'include',
    });
    expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
    expect(errors).toStrictEqual(['hook listener failed: boom', 'hook listener failed: plain']);
  });

  it('auto-allows a request that matches an allow rule and records it', async () => {
    const audit: AuditEntry[] = [];
    await startServer({
      rules: [allowLs],
      audit: {
        append: async (entry) => {
          audit.push(entry);
          await Promise.resolve();
        },
      },
    });
    const requested: PermissionRequest[] = [];
    bus.on('permission.requested', (request) => requested.push(request));
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'ls -la' }));
    expect(await opened.next()).toStrictEqual({
      id: 'm1',
      output: {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      },
    });
    expect(requested).toStrictEqual([]);
    expect(audit).toStrictEqual([
      {
        at: 1002,
        requestId: 'perm-1',
        sessionId: 'sess',
        agentId: 'sess',
        toolName: 'Bash',
        ruleId: 'allow-ls',
        behavior: 'allow',
      },
    ]);
  });

  it('auto-denies with the rule in the message, even when an allow rule also matches', async () => {
    const audit: AuditEntry[] = [];
    const server = await startServer({
      audit: {
        append: async (entry) => {
          audit.push(entry);
          await Promise.resolve();
        },
      },
    });
    server.setRules([{ ...allowLs, pattern: null }, denyRm]);
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'rm x' }));
    expect(await opened.next()).toStrictEqual({
      id: 'm1',
      output: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: 'Denied by Overlord auto-approve rule deny-rm: no deletes',
          },
        },
      },
    });
    expect(audit.map((entry) => [entry.ruleId, entry.behavior])).toStrictEqual([
      ['deny-rm', 'deny'],
    ]);
  });

  describe('SendMessage on PreToolUse', () => {
    const denyPeers: AutoApproveRule = {
      id: 'deny-peers',
      enabled: true,
      behavior: 'deny',
      tool: 'SendMessage',
      pattern: 'uds:*',
      description: 'no other sessions',
    };

    it('denies a matching send with the documented PreToolUse output and records it', async () => {
      const audit: AuditEntry[] = [];
      await startServer({
        rules: [{ ...denyPeers, behavior: 'allow', id: 'allow-all', pattern: null }, denyPeers],
        audit: {
          append: async (entry) => {
            audit.push(entry);
            await Promise.resolve();
          },
        },
      });
      const opened = await client();
      opened.send('m1', sendEvent('uds:/tmp/cc-socks/9.sock'));
      expect(await opened.next()).toStrictEqual({
        id: 'm1',
        output: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              'Denied by Overlord auto-approve rule deny-peers: no other sessions',
          },
        },
      });
      expect(audit).toStrictEqual([
        {
          at: 1002,
          requestId: 'perm-1',
          sessionId: 'sess',
          agentId: 'agent-7',
          toolName: 'SendMessage',
          ruleId: 'deny-peers',
          behavior: 'deny',
        },
      ]);
    });

    it('never allows through PreToolUse, even when an allow rule matches', async () => {
      const audit: AuditEntry[] = [];
      await startServer({
        rules: [{ ...denyPeers, behavior: 'allow', id: 'allow-all', pattern: null }],
        audit: {
          append: async (entry) => {
            audit.push(entry);
            await Promise.resolve();
          },
        },
      });
      const opened = await client();
      opened.send('m1', sendEvent('uds:/tmp/cc-socks/9.sock'));
      expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
      expect(audit).toStrictEqual([]);
    });

    it('lets a send through when no deny rule covers its recipient', async () => {
      await startServer({ rules: [denyPeers, { ...denyPeers, id: 'off', enabled: false }] });
      const opened = await client();
      opened.send('m1', sendEvent('main'));
      expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
      opened.send('m2', sendEvent(null));
      expect(await opened.next()).toStrictEqual({ id: 'm2', output: {} });
    });

    it('leaves other tools to PermissionRequest', async () => {
      const denyAll: AutoApproveRule = { ...denyPeers, tool: '*', pattern: null };
      await startServer({ rules: [denyAll] });
      const opened = await client();
      opened.send('m1', sendEvent('uds:/x', 'Bash'));
      expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
      opened.send('m2', sendEvent('uds:/x'));
      expect(await opened.next()).toMatchObject({
        id: 'm2',
        output: { hookSpecificOutput: { permissionDecision: 'deny' } },
      });
    });

    it('ignores PostToolUse for SendMessage', async () => {
      await startServer({ rules: [denyPeers] });
      const opened = await client();
      opened.send('m1', {
        ...sendEvent('uds:/x'),
        hook_event_name: 'PostToolUse',
        tool_response: {},
      });
      expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
    });
  });

  it('reports a failed audit write', async () => {
    await startServer({
      rules: [allowLs],
      audit: {
        append: async () => {
          await Promise.resolve();
          throw new Error('disk full');
        },
      },
    });
    const errors: string[] = [];
    bus.on('source.error', (error) => errors.push(error.message));
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'ls' }));
    await opened.next();
    await waitFor(() => errors.length > 0);
    expect(errors).toStrictEqual(['audit log write failed: disk full']);
  });

  it('works without an audit log', async () => {
    await startServer({ rules: [allowLs], audit: null });
    const errors: string[] = [];
    bus.on('source.error', (error) => errors.push(error.message));
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'ls' }));
    expect(await opened.next()).toMatchObject({ id: 'm1' });
    expect(errors).toStrictEqual([]);
  });

  it('holds an unmatched request until it is resolved', async () => {
    const server = await startServer({ rules: [allowLs] });
    const requested: PermissionRequest[] = [];
    const resolved: string[] = [];
    bus.on('permission.requested', (request) => requested.push(request));
    bus.on('permission.resolved', (event) => resolved.push(event.requestId));
    const opened = await client();
    opened.send('m1', { ...permissionEvent({ command: 'git push' }), agent_id: 'a1' });
    await waitFor(() => requested.length === 1);
    expect(requested[0]).toStrictEqual({
      id: 'perm-1',
      sessionId: 'sess',
      agentId: 'a1',
      toolName: 'Bash',
      input: { command: 'git push' },
      requestedAt: 1002,
      source: 'hook',
    });
    expect(server.pendingRequests()).toStrictEqual(requested);
    expect(server.resolvePermission('nope', { behavior: 'allow', ruleId: null })).toBe(false);
    expect(server.resolvePermission('perm-1', { behavior: 'allow', ruleId: null })).toBe(true);
    expect(await opened.next()).toStrictEqual({
      id: 'm1',
      output: {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      },
    });
    expect(resolved).toStrictEqual(['perm-1']);
    expect(server.pendingRequests()).toStrictEqual([]);
    expect(server.resolvePermission('perm-1', { behavior: 'allow', ruleId: null })).toBe(false);
  });

  it('sends a deny decision with its message', async () => {
    const server = await startServer();
    const requested: PermissionRequest[] = [];
    bus.on('permission.requested', (request) => requested.push(request));
    const opened = await client();
    opened.send('m1', permissionEvent({ file_path: '/etc/hosts' }, 'Edit'));
    await waitFor(() => requested.length === 1);
    server.resolvePermission('perm-1', {
      behavior: 'deny',
      message: 'not that file',
      ruleId: null,
    });
    expect(await opened.next()).toStrictEqual({
      id: 'm1',
      output: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'not that file' },
        },
      },
    });
  });

  it('answers with an empty output when the hold time runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = await startServer({ holdMs: 5000 });
    const resolved: string[] = [];
    bus.on('permission.resolved', (event) => resolved.push(event.requestId));
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'make' }));
    await waitFor(() => server.pendingRequests().length === 1);
    vi.advanceTimersByTime(4999);
    expect(server.pendingRequests()).toHaveLength(1);
    expect(resolved).toStrictEqual([]);
    vi.advanceTimersByTime(1);
    expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
    expect(resolved).toStrictEqual(['perm-1']);
    expect(server.pendingRequests()).toStrictEqual([]);
  });

  it('defaults the hold time to ten minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = await startServer();
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'make' }));
    await waitFor(() => server.pendingRequests().length === 1);
    vi.advanceTimersByTime(DEFAULT_HOLD_MS - 1);
    expect(server.pendingRequests()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(await opened.next()).toStrictEqual({ id: 'm1', output: {} });
  });

  it('drops a held request when the hook goes away', async () => {
    const server = await startServer();
    const resolved: string[] = [];
    bus.on('permission.resolved', (event) => resolved.push(event.requestId));
    const keep = await client();
    keep.send('k1', permissionEvent({ command: 'keep' }));
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'make' }));
    await waitFor(() => server.pendingRequests().length === 2);
    opened.close();
    await waitFor(() => resolved.length === 1);
    expect(server.pendingRequests().map((request) => request.input)).toStrictEqual([
      { command: 'keep' },
    ]);
    expect(server.resolvePermission(resolved[0] ?? '', { behavior: 'allow', ruleId: null })).toBe(
      false,
    );
  });

  it('releases held requests on stop', async () => {
    const server = await startServer();
    const resolved: string[] = [];
    bus.on('permission.resolved', (event) => resolved.push(event.requestId));
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'make' }));
    await waitFor(() => server.pendingRequests().length === 1);
    await server.stop();
    await opened.closed;
    expect(resolved).toStrictEqual(['perm-1']);
    expect(server.pendingRequests()).toStrictEqual([]);
    await server.stop();
  });

  it('keeps the request held when a permission listener throws', async () => {
    const server = await startServer();
    const errors: string[] = [];
    bus.on('source.error', (error) => errors.push(error.message));
    bus.on('permission.requested', () => {
      throw new Error('ui down');
    });
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'make' }));
    await waitFor(() => errors.length === 1);
    expect(errors).toStrictEqual(['hook listener failed: ui down']);
    expect(server.pendingRequests()).toHaveLength(1);
  });

  it('shrugs off a hook that hangs up before the reply', async () => {
    const server = await startServer();
    const events: HookEvent[] = [];
    server.onEvent((event) => events.push(event));
    for (let round = 0; round < 5; round += 1) {
      const opened = await client();
      opened.send(`m${String(round)}`, { ...base, hook_event_name: 'Stop' });
      opened.close();
    }
    await waitFor(() => events.length === 5);
    const opened = await client();
    opened.send('after', { ...base, hook_event_name: 'Stop' });
    expect(await opened.next()).toStrictEqual({ id: 'after', output: {} });
  });

  it('stops cleanly when it never started', async () => {
    const server = new HookServer({ socketPath: file, bus });
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('uses real ids and clock by default', async () => {
    const server = new HookServer({ socketPath: file, bus });
    servers.push(server);
    await server.start();
    const requested: PermissionRequest[] = [];
    bus.on('permission.requested', (request) => requested.push(request));
    const before = Date.now();
    const opened = await client();
    opened.send('m1', permissionEvent({ command: 'make' }));
    await waitFor(() => requested.length === 1);
    expect(requested[0]?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(requested[0]?.requestedAt).toBeGreaterThanOrEqual(before);
    expect(requested[0]?.requestedAt).toBeLessThanOrEqual(Date.now());
  });
});
