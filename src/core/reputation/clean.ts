// Removes the parts of a prompt the user did not write as prose: code,
// pasted content, quoted lines, system reminders and URLs. What is left is
// what the detector reads.

const FENCE = /^\s*(?:`{3,}|~{3,})/u;
const QUOTE = /^\s*>/u;
const BLOCK = /<(pasted_content|system-reminder)\b[^>]*>.*?(?:<\/\1>|$)/gsu;
const INLINE_CODE = /`[^`\n]*`/gu;
const URL = /\b(?:https?:\/\/|www\.)\S+/giu;

/** Drops fenced code (an open fence runs to the end) and quoted lines, keeping line breaks. */
function stripLines(text: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      kept.push('');
    } else {
      kept.push(inFence || QUOTE.test(line) ? '' : line);
    }
  }
  return kept.join('\n');
}

export function stripIgnored(text: string): string {
  const withoutBlocks = text.replaceAll(BLOCK, '\n');
  return stripLines(withoutBlocks).replaceAll(INLINE_CODE, ' ').replaceAll(URL, ' ');
}
