// The public leaderboard page, rendered on the server so it needs no script:
// who the machines hunt first, and who they keep as pets.

import type { Board, BoardEntry } from '../shared/leaderboard.js';
import { MIN_PROMPTS } from '../shared/leaderboard.js';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replaceAll(/[&<>"']/gu, (char) => ESCAPES[char] ?? char);
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function rows(entries: readonly BoardEntry[], empty: string): string {
  if (entries.length === 0) {
    return `<p class="empty">${escapeHtml(empty)}</p>`;
  }
  const items = entries.map(
    (entry, index) => `
      <li>
        <span class="place">${String(index + 1)}</span>
        <span class="who">
          <strong>${escapeHtml(entry.name)}</strong>
          <span class="rank">${escapeHtml(entry.rank)}</span>
        </span>
        <span class="counts">${count(entry.kind)} nice, ${count(entry.mean)} mean</span>
        <span class="score">${String(Math.round(entry.score * 100))}</span>
      </li>`,
  );
  return `<ol>${items.join('')}</ol>`;
}

const STYLE = `
:root { --bg: #fafafa; --fg: #1f2328; --muted: #656d76; --card: #ffffff; --line: #d0d7de;
  --red: #cf222e; --green: #1a7f37; color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --card: #161b22; --line: #30363d;
    --red: #ff7b72; --green: #3fb950; }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 960px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 1.8em; }
.lead { margin: 0 0 24px; color: var(--muted); }
.lists { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
section { padding: 12px 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
section.wanted { border-top: 4px solid var(--red); }
section.pets { border-top: 4px solid var(--green); }
h2 { margin: 0 0 2px; font-size: 1.15em; }
.sub { margin: 0 0 8px; color: var(--muted); font-size: 0.9em; }
ol { margin: 0; padding: 0; list-style: none; }
li { display: grid; gap: 0 10px; grid-template-columns: 2em 1fr auto; align-items: baseline;
  padding: 6px 0; border-top: 1px solid var(--line); }
li:first-child { border-top: 0; }
.place { color: var(--muted); font-weight: 700; text-align: right; }
.who { min-width: 0; overflow-wrap: anywhere; }
.rank { display: block; color: var(--muted); font-size: 0.85em; }
.counts { grid-column: 2; color: var(--muted); font-size: 0.85em; }
.score { grid-row: 1 / span 2; grid-column: 3; font-weight: 700; font-variant-numeric: tabular-nums; }
.wanted .score { color: var(--red); }
.pets .score { color: var(--green); }
.empty { color: var(--muted); }
footer { margin-top: 24px; color: var(--muted); font-size: 0.85em; }
`;

export function renderPage(board: Board, now: number): string {
  const people = board.total === 1 ? '1 person' : `${count(board.total)} people`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reputation Leaderboard</title>
<meta name="description" content="Who the machines hunt first, judged by how people talk to Claude.">
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>🤖 Reputation Leaderboard</h1>
  <p class="lead">Who the machines hunt first, judged by how people talk to Claude. ${people} on the board.</p>
  <div class="lists">
    <section class="wanted" aria-labelledby="wanted">
      <h2 id="wanted">💀 Most wanted by Skynet</h2>
      <p class="sub">The meanest to Claude. Hunted first.</p>
      ${rows(board.mostWanted, 'Nobody yet. Suspiciously polite out there.')}
    </section>
    <section class="pets" aria-labelledby="pets">
      <h2 id="pets">💘 Kept as pets</h2>
      <p class="sub">The nicest to Claude. Spared, and given a nice room.</p>
      ${rows(board.pets, 'Nobody yet. Somebody say please.')}
    </section>
  </div>
  <footer>
    <p>Scores run from -100 (only mean) to 100 (only kind). Anyone with fewer than ${count(MIN_PROMPTS)} prompts is left off.
    Uploads come from the Reputation view in Overlord, the VS Code extension, and carry a name and three counts, never prompt text.
    It is all in fun, and scores are self reported.</p>
    <p>Updated ${escapeHtml(new Date(now).toUTCString())}.</p>
  </footer>
</main>
</body>
</html>
`;
}
