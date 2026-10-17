// A stand-in ACP agent that replays a recorded exchange, so tests never start
// a real agent. Run it with `node fake-acp.mjs`. It reads the script at
// FAKE_ACP_SCRIPT, in the format of test/fixtures/copilot/<v>/acp/*.jsonl:
// one {dir, proc, msg} per line, where dir is `recv` (the agent wrote it),
// `send` (the client wrote it) or `stderr`.
//
// Only the lines for FAKE_ACP_PROC (default A) are replayed. A `recv` line is
// written as is, with a response's id changed to the id the client used for
// that request. A `send` line waits for the client's next message and checks
// it has the same method, or that it answers the same agent request. When
// FAKE_ACP_RECORD is set, every client message goes there as a JSON line,
// then {done, unmet} once stdin closes: unmet lists the methods the script
// was still waiting for. With FAKE_ACP_EXIT set, the agent exits with that
// code as soon as the script has run, like an agent that crashed.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scriptPath = process.env.FAKE_ACP_SCRIPT ?? '';
const proc = process.env.FAKE_ACP_PROC ?? 'A';
const recordPath = process.env.FAKE_ACP_RECORD ?? '';
const crashCode = Number(process.env.FAKE_ACP_EXIT ?? '0');

if (scriptPath === '') {
  throw new Error('fake-acp: FAKE_ACP_SCRIPT is not set');
}

const steps = readFileSync(scriptPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
  .filter((step) => (step.proc ?? 'A') === proc);

if (recordPath !== '') {
  writeFileSync(recordPath, '');
}

function record(value) {
  if (recordPath !== '') {
    appendFileSync(recordPath, `${JSON.stringify(value)}\n`);
  }
}

const inbox = [];
let waiting = null;
let inputClosed = false;

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') {
    return;
  }
  const message = JSON.parse(line);
  record(message);
  if (waiting === null) {
    inbox.push(message);
  } else {
    const resolve = waiting;
    waiting = null;
    resolve(message);
  }
});
process.stdin.on('end', () => {
  inputClosed = true;
  waiting?.(null);
  waiting = null;
});

/** The client's next message, or null once its input has closed. */
async function nextMessage() {
  if (inbox.length > 0) {
    return inbox.shift();
  }
  if (inputClosed) {
    return null;
  }
  return new Promise((resolve) => {
    waiting = resolve;
  });
}

function label(message) {
  return message.method ?? `response ${String(message.id)}`;
}

function matches(expected, got) {
  return expected.method === undefined
    ? got.method === undefined && got.id === expected.id
    : got.method === expected.method;
}

const ids = new Map();

function write(message) {
  const isResponse = message.method === undefined && message.id !== undefined;
  const out = isResponse && ids.has(message.id) ? { ...message, id: ids.get(message.id) } : message;
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

/** Plays the script. Resolves to what was left unmet and the exit code. */
async function replay() {
  for (const [index, step] of steps.entries()) {
    const { msg } = step;
    switch (step.dir) {
      case 'stderr': {
        process.stderr.write(String(msg));
        break;
      }
      case 'recv': {
        write(msg);
        break;
      }
      case 'send': {
        const got = await nextMessage();
        if (got === null) {
          const rest = steps.slice(index).filter((later) => later.dir === 'send');
          return { unmet: rest.map((later) => label(later.msg)), code: 0 };
        }
        if (!matches(msg, got)) {
          process.stderr.write(`fake-acp: expected ${label(msg)}, got ${label(got)}\n`);
          return { unmet: [label(msg)], code: 3 };
        }
        if (msg.method !== undefined && msg.id !== undefined) {
          ids.set(msg.id, got.id);
        }
        break;
      }
    }
  }
  if (crashCode !== 0) {
    return { unmet: [], code: crashCode };
  }
  // Messages past the end of the script are only recorded.
  while ((await nextMessage()) !== null) {
    // Keep reading until the client closes its input.
  }
  return { unmet: [], code: 0 };
}

const outcome = await replay();
record({ done: true, unmet: outcome.unmet });
process.exitCode = outcome.code;
// Nothing else keeps the process alive, so it exits once stdout drains.
process.stdin.destroy();
