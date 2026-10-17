// Tool output and pasted prompts carry terminal escapes and control
// characters. Every place that shows that text cleans it here first.

// Terminal escapes that tool output carries: CSI (colors, cursor moves), OSC
// (titles, links) and the two-byte ESC forms.
const ESC = '\u001B';
const CSI = '\u009B';
const BEL = '\u0007';
const CONTROL = /\p{Cc}/u;

/** Index just past a CSI body: parameter and intermediate bytes, then one final byte. */
function csiEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0;
    if (code < 0x20 || code > 0x3f) {
      return code >= 0x40 && code <= 0x7e ? index + 1 : index;
    }
    index += 1;
  }
  return index;
}

/** Index just past an OSC body, which ends at BEL or ESC backslash. */
function oscEnd(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === BEL) {
      return index + 1;
    }
    if (text[index] === ESC && text[index + 1] === '\\') {
      return index + 2;
    }
  }
  return text.length;
}

function escapeEnd(text: string, start: number): number {
  if (text[start] === CSI) {
    return csiEnd(text, start + 1);
  }
  const next = text[start + 1];
  if (next === '[') {
    return csiEnd(text, start + 2);
  }
  if (next === ']') {
    return oscEnd(text, start + 2);
  }
  return Math.min(start + 2, text.length);
}

/**
 * Text as a terminal would show it: escapes dropped, a carriage return
 * overwriting its line the way a progress bar does, and no stray control
 * characters left to print as boxes.
 */
export function plainText(text: string): string {
  const lines: string[] = [];
  let line = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === ESC || char === CSI) {
      index = escapeEnd(text, index);
      continue;
    }
    if (char === '\n') {
      lines.push(line);
      line = '';
    } else if (char === '\r') {
      line = text[index + 1] === '\n' ? line : '';
    } else if (char === '\t' || !CONTROL.test(char)) {
      line += char;
    }
    index += 1;
  }
  lines.push(line);
  return lines.join('\n');
}
