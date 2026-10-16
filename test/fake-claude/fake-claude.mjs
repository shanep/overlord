// A stand-in for the Claude Code CLI, so tests never reach the real API.
//
// The Agent SDK spawns it through the `pathToClaudeCodeExecutable` option.
// The SDK treats a path ending in .js or .mjs as a script and runs it with
// `node <path> <args>`, so no shebang, chmod or native binary is needed. It
// passes --output-format stream-json --input-format stream-json --verbose and
// then talks newline-delimited JSON on stdin and stdout:
//
//   SDK -> CLI  {type:'control_request', request_id, request:{subtype, ...}}
//   CLI -> SDK  {type:'control_response', response:{subtype:'success', request_id, response}}
//   SDK -> CLI  {type:'user', message:{role:'user', content}} starts a turn
//   CLI -> SDK  {type:'control_request', request:{subtype:'can_use_tool', ...}}
//
// The conversation comes from the JSON scenario at FAKE_CLAUDE_SCENARIO. When
// FAKE_CLAUDE_RECORD is set, the argv, cwd and FAKE_ECHO_* variables are
// written there so tests can check what the SDK passed.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;

function argumentValue(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index !== -1) {
    return argv[index + 1];
  }
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function record() {
  const target = process.env.FAKE_CLAUDE_RECORD;
  if (target === undefined || target === '') {
    return;
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('FAKE_ECHO_')),
  );
  writeFileSync(target, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }));
}

function loadScenario() {
  if (scenarioPath === undefined || scenarioPath === '') {
    process.stderr.write('fake-claude: FAKE_CLAUDE_SCENARIO is not set\n');
    return;
  }
  return JSON.parse(readFileSync(scenarioPath, 'utf8'));
}

const scenario = loadScenario();
const state = {
  sessionId: argumentValue('--session-id') ?? randomUUID(),
  model: argumentValue('--model') ?? scenario?.model ?? 'claude-fake',
  permissionMode: argumentValue('--permission-mode') ?? 'default',
  turnIndex: 0,
  interrupted: false,
  wake: undefined,
  inputClosed: false,
  busy: false,
};
const queue = [];
const pending = new Map();

function envelope(message) {
  return { ...message, session_id: state.sessionId, uuid: randomUUID() };
}

function initMessage() {
  return envelope({
    type: 'system',
    subtype: 'init',
    apiKeySource: 'none',
    claude_code_version: '0.0.0-fake',
    cwd: process.cwd(),
    tools: scenario.tools ?? [],
    mcp_servers: scenario.mcpServers ?? [],
    model: state.model,
    permissionMode: state.permissionMode,
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
  });
}

function assistant(messageId, block, step) {
  return envelope({
    type: 'assistant',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: state.model,
      content: [block],
      stop_reason: null,
      stop_sequence: null,
      usage: step.usage ?? {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: step.parentToolUseId ?? null,
  });
}

function toolResult(toolUseId, text, isError) {
  return envelope({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }],
    },
    parent_tool_use_id: null,
  });
}

function resultMessage(spec) {
  const isError = spec.is_error ?? false;
  return envelope({
    type: 'result',
    subtype: spec.subtype ?? 'success',
    is_error: isError,
    duration_ms: spec.duration_ms ?? 100,
    duration_api_ms: spec.duration_api_ms ?? 80,
    num_turns: spec.num_turns ?? 1,
    stop_reason: 'end_turn',
    total_cost_usd: spec.total_cost_usd ?? 0,
    usage: spec.usage ?? { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    // Like the real CLI, a success carries result text and an error a list.
    ...(isError ? { errors: spec.errors ?? [] } : { result: spec.result ?? '' }),
  });
}

function requestControl(request) {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    send({ type: 'control_request', request_id: requestId, request });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    state.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

async function runToolUse(step, messageId) {
  send(
    assistant(
      messageId,
      { type: 'tool_use', id: step.id, name: step.name, input: step.input },
      step,
    ),
  );
  if (step.askPermission !== true) {
    send(toolResult(step.id, step.result ?? '', false));
    return;
  }
  const answer = await requestControl({
    subtype: 'can_use_tool',
    tool_name: step.name,
    input: step.input,
    tool_use_id: step.id,
    permission_suggestions: [],
  });
  if (answer?.behavior === 'allow') {
    send(toolResult(step.id, step.result ?? '', false));
  } else {
    send(toolResult(step.id, answer?.message ?? 'denied', true));
  }
}

async function runStep(step, messageId) {
  switch (step.type) {
    case 'text': {
      send(assistant(messageId, { type: 'text', text: step.text }, step));
      return false;
    }
    case 'thinking': {
      send(
        assistant(messageId, { type: 'thinking', thinking: step.thinking, signature: '' }, step),
      );
      return false;
    }
    case 'tool_use': {
      await runToolUse(step, messageId);
      return true;
    }
    case 'wait': {
      await sleep(step.ms ?? 10_000);
      return false;
    }
    default: {
      send(envelope(step.message));
      return false;
    }
  }
}

async function runTurn() {
  const turns = scenario.turns ?? [];
  const turn = turns[Math.min(state.turnIndex, turns.length - 1)] ?? { steps: [], result: {} };
  state.turnIndex += 1;
  state.interrupted = false;
  send(initMessage());
  let messageId = `msg_${randomUUID()}`;
  for (const step of turn.steps ?? []) {
    if (state.interrupted) {
      break;
    }
    const startsNewMessage = await runStep(step, messageId);
    if (startsNewMessage) {
      messageId = `msg_${randomUUID()}`;
    }
  }
  if (state.interrupted) {
    send(
      resultMessage({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] }),
    );
    return;
  }
  send(resultMessage(turn.result ?? {}));
}

async function drain() {
  if (state.busy) {
    return;
  }
  state.busy = true;
  while (queue.length > 0) {
    queue.shift();
    await runTurn();
  }
  state.busy = false;
  if (state.inputClosed) {
    process.exitCode = scenario.exitCode ?? 0;
  }
}

function controlAnswer(request) {
  switch (request.subtype) {
    case 'initialize': {
      return {
        commands: [],
        agents: [],
        output_style: 'default',
        available_output_styles: ['default'],
        models: [],
        account: {},
      };
    }
    case 'interrupt': {
      state.interrupted = true;
      state.wake?.();
      return { still_queued: [] };
    }
    case 'set_model': {
      state.model = request.model ?? scenario.model ?? 'claude-fake';
      return {};
    }
    case 'set_permission_mode': {
      state.permissionMode = request.mode;
      return {};
    }
    case 'get_context_usage': {
      return scenario.contextUsage ?? { categories: [], totalTokens: 0, maxTokens: 200_000 };
    }
    default: {
      return;
    }
  }
}

function onControlRequest(message) {
  const answer = controlAnswer(message.request);
  if (answer === undefined) {
    send({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: `fake-claude: unsupported ${message.request.subtype}`,
      },
    });
    return;
  }
  send({
    type: 'control_response',
    response: { subtype: 'success', request_id: message.request_id, response: answer },
  });
}

function onLine(line) {
  if (line.trim() === '') {
    return;
  }
  const message = JSON.parse(line);
  switch (message.type) {
    case 'control_request': {
      onControlRequest(message);

      break;
    }
    case 'control_response': {
      const resolve = pending.get(message.response.request_id);
      pending.delete(message.response.request_id);
      resolve?.(message.response.response);

      break;
    }
    case 'user': {
      queue.push(message);
      void drain();

      break;
    }
    // No default
  }
}

if (scenario === undefined) {
  process.exitCode = 2;
} else {
  record();
  const lines = createInterface({ input: process.stdin });
  lines.on('line', onLine);
  lines.on('close', () => {
    state.inputClosed = true;
    void drain();
  });
}
