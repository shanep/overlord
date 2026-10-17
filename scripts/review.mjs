// Reviews a branch before it lands: a fresh Claude session with no stake in
// the change reads the diff against the default branch, can open files for
// context, and says whether anything in it is a real bug. Sessions landed
// their own work after only their own tests, so a second reader catches
// what the author's context hides.
//
// Usage: npm run review [-- base-ref]. npm run land runs it before landing.
// Exits 0 when the change passes or the review could not run, 2 when it
// found a blocking problem. LAND_REVIEW_MODEL picks the model (sonnet by
// default, to go easy on the usage limit), and changes under
// LAND_REVIEW_MIN_LINES changed lines (30) are not reviewed.
// cspell:words numstat
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TIMEOUT_MS = 15 * 60_000;
const MAX_DIFF_CHARS = 200_000;
const MIN_LINES = Number.parseInt(process.env.LAND_REVIEW_MIN_LINES ?? '', 10) || 30;
const MODEL = process.env.LAND_REVIEW_MODEL || 'sonnet';

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'block'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocking', 'note'] },
          file: { type: 'string' },
          line: { type: 'number' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'file', 'problem'],
      },
    },
  },
  required: ['verdict', 'findings'],
};

const PROMPT = `You review a change before it lands on the default branch. The diff is on stdin. You did not write it, so read it with fresh eyes.

Look for real problems: wrong logic, a case the code gets wrong, data loss, a security hole, a race, an error that is swallowed, a test that cannot fail, or a change that breaks a caller elsewhere in the repository. Open files with Read, Grep and Glob when the diff alone does not show whether something is wrong. Do not edit anything.

Do not comment on style, naming, formatting or taste. Do not ask for more tests unless a change is untested in a way that hides a bug.

Mark a finding "blocking" only when you can name the input or state that breaks and what goes wrong. Everything else is a "note". The verdict is "block" when there is at least one blocking finding, else "pass".`;

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Changed lines (added plus removed) between base and HEAD. */
function changedLines(base, cwd) {
  let total = 0;
  for (const line of git(['diff', '--numstat', `${base}...HEAD`], cwd).split('\n')) {
    const [added, removed] = line.split('\t');
    total += (Number.parseInt(added, 10) || 0) + (Number.parseInt(removed, 10) || 0);
  }
  return total;
}

function cacheFile(cwd) {
  const common = path.resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd).trim());
  const tree = git(['rev-parse', 'HEAD^{tree}'], cwd).trim();
  return path.join(common, 'land-review', `${tree}.json`);
}

/** The JSON the reviewer gave, from structured output or the text of its answer. */
function parseReview(stdout) {
  const outer = JSON.parse(stdout);
  if (outer.structured_output && typeof outer.structured_output === 'object') {
    return outer.structured_output;
  }
  const text = String(outer.result ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('the reviewer did not answer with JSON');
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function runClaude(diff, cwd) {
  const args = [
    '-p',
    PROMPT,
    '--model',
    MODEL,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SCHEMA),
    '--allowedTools',
    'Read',
    'Grep',
    'Glob',
    '--disallowedTools',
    'Edit',
    'Write',
    'Bash',
    'NotebookEdit',
    '--no-session-persistence',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`the review took longer than ${String(TIMEOUT_MS / 60_000)} minutes`));
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude exited ${String(code)}: ${stderr.trim().slice(0, 500)}`));
      }
    });
    // A claude that exits before reading the diff closes the pipe. The exit handler reports it.
    child.stdin.on('error', (error) => {
      stderr += `stdin: ${error.message}\n`;
    });
    child.stdin.end(diff);
  });
}

function print(findings, verdict, blocking) {
  for (const finding of findings) {
    const where = finding.line ? `${finding.file}:${String(finding.line)}` : finding.file;
    process.stderr.write(`\n[${finding.severity}] ${where}\n  ${finding.problem}\n`);
    if (finding.fix) {
      process.stderr.write(`  Fix: ${finding.fix}\n`);
    }
  }
  if (verdict === 'block') {
    process.stderr.write(
      `\nreview: ${String(blocking)} blocking problem(s). Fix them, commit and land again. If one is wrong, land again with --accept-review.\n`,
    );
  } else {
    const notes = findings.length > 0 ? ' with notes' : '';
    process.stderr.write(`\nreview: passed${notes}.\n`);
  }
}

/** True when this tree passed before, or was blocked and is now accepted. */
function remembered(cache, accept) {
  try {
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    if (saved.verdict === 'pass' || accept) {
      writeFileSync(cache, JSON.stringify({ ...saved, verdict: 'pass' }));
      return true;
    }
  } catch {
    // Not reviewed before.
  }
  return false;
}

/** The diff with its stat on top, cut when it is too long to send whole. */
function diffFor(base, cwd) {
  const range = `${base}...HEAD`;
  const diff = [git(['diff', '--stat', range], cwd), git(['diff', range], cwd)].join('\n');

  return diff.length > MAX_DIFF_CHARS
    ? `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[The diff is cut here. Open the remaining files listed in the stat above.]\n`
    : diff;
}

/**
 * Reviews HEAD against base. Returns 'pass', 'block' or 'skipped'. A passed
 * or accepted tree is remembered, so landing the same tree again does not
 * review it twice.
 */
export async function review(base, cwd = process.cwd(), { accept = false } = {}) {
  const cache = cacheFile(cwd);
  if (remembered(cache, accept)) {
    process.stderr.write('review: this exact change was already reviewed or accepted.\n');
    return 'pass';
  }
  const lines = changedLines(base, cwd);
  if (lines < MIN_LINES) {
    process.stderr.write(`review: skipped, only ${String(lines)} changed lines.\n`);
    return 'skipped';
  }
  process.stderr.write(`review: ${MODEL} is reading ${String(lines)} changed lines...\n`);
  let result;
  try {
    result = parseReview(await runClaude(diffFor(base, cwd), cwd));
  } catch (error) {
    process.stderr.write(`review: could not run, so landing goes ahead (${error.message}).\n`);
    return 'skipped';
  }
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const blocking = findings.filter((finding) => finding.severity === 'blocking').length;
  const verdict = blocking > 0 ? 'block' : 'pass';
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ verdict, findings, model: MODEL, at: Date.now() }));
  print(findings, verdict, blocking);
  return verdict;
}

// Run as a command, but not when land.mjs imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const base = process.argv[2] ?? 'origin/HEAD';
  const verdict = await review(base);
  process.exitCode = verdict === 'block' ? 2 : 0;
}
