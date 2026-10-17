// A stand-in for `copilot mcp add` and `copilot mcp remove` in the MCP store
// tests, run as `node <this file> mcp add ...`. It edits mcp-config.json in
// COPILOT_HOME the way the documented command does: a local server as
// { type: "local", command, args, env, tools }, a remote one as
// { type, url, headers, tools }. It refuses to run without COPILOT_HOME, so
// it can never touch a real ~/.copilot. FAKE_COPILOT_STDERR and
// FAKE_COPILOT_EXIT make it fail the way the real one would.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

class Failure extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Splits `add` args into the options, the server name, and what follows it. */
function parseAdd(args) {
  const env = {};
  const headers = {};
  let transport = 'local';
  let index = 0;
  for (; index < args.length && args[index].startsWith('--') && args[index] !== '--'; index += 2) {
    const [flag, value] = [args[index], args[index + 1] ?? ''];
    switch (flag) {
      case '--env': {
        const at = value.indexOf('=');
        env[value.slice(0, at)] = value.slice(at + 1);
        break;
      }
      case '--header': {
        const at = value.indexOf(':');
        headers[value.slice(0, at)] = value.slice(at + 1).trim();
        break;
      }
      case '--transport': {
        transport = value;
        break;
      }
      default: {
        throw new Failure(`fake copilot: unknown option ${flag}`);
      }
    }
  }
  const name = args[index];
  const rest = args.slice(index + 1);
  if (name === undefined) {
    throw new Failure('fake copilot: missing server name');
  }
  if (transport !== 'local') {
    return { name, server: { type: transport, url: rest[0], headers, tools: ['*'] } };
  }
  if (rest[0] !== '--' || rest.length < 2) {
    throw new Failure('fake copilot: a local server needs -- COMMAND');
  }
  const [command, ...commandArgs] = rest.slice(1);
  return { name, server: { type: 'local', command, args: commandArgs, env, tools: ['*'] } };
}

function run(argv, home) {
  if (home === '') {
    throw new Failure('fake copilot: COPILOT_HOME must point at a temp folder', 2);
  }
  const stderr = process.env.FAKE_COPILOT_STDERR ?? '';
  if (stderr !== '') {
    throw new Failure(stderr, Number(process.env.FAKE_COPILOT_EXIT ?? '1'));
  }
  const [group, verb, ...args] = argv;
  if (group !== 'mcp') {
    throw new Failure(`fake copilot: only mcp commands, not ${String(group)}`);
  }
  const file = path.join(home, 'mcp-config.json');
  const servers = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).mcpServers : {};
  let next;
  if (verb === 'add') {
    const { name, server } = parseAdd(args);
    if (Object.hasOwn(servers, name)) {
      throw new Failure(`Server "${name}" already exists`);
    }
    next = { ...servers, [name]: server };
  } else if (verb === 'remove') {
    const [name] = args;
    if (!Object.hasOwn(servers, name)) {
      throw new Failure(`Server "${name}" not found`);
    }
    next = Object.fromEntries(Object.entries(servers).filter(([key]) => key !== name));
  } else {
    throw new Failure(`fake copilot: unknown mcp command ${String(verb)}`);
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ mcpServers: next }, null, 2)}\n`);
}

try {
  run(process.argv.slice(2), process.env.COPILOT_HOME ?? '');
} catch (error) {
  if (!(error instanceof Failure)) {
    throw error;
  }
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.code;
}
