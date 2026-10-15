// Fail the build if any tracked text file contains an em dash or en dash.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const EM_DASH = String.fromCodePoint(0x20_14);
const EN_DASH = String.fromCodePoint(0x20_13);
const TEXT_FILE = /\.(?:ts|tsx|mjs|cjs|js|json|jsonc|md|yml|yaml|css|html|txt)$/u;

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter((file) => TEXT_FILE.test(file) && file !== 'package-lock.json');

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [index, line] of text.split('\n').entries()) {
    if (line.includes(EM_DASH) || line.includes(EN_DASH)) {
      hits.push(`${file}:${String(index + 1)}: ${line.trim()}`);
    }
  }
}

if (hits.length > 0) {
  process.stderr.write(
    `Em or en dash found, use a comma, colon or parentheses:\n${hits.join('\n')}\n`,
  );
  process.exitCode = 1;
}
