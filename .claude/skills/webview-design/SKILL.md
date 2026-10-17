---
name: webview-design
description: The look every Overlord view follows, with the shared card components, when to use cards or a table, colors, buttons, and how to screenshot a view before committing. Use whenever you build or change a view or panel under webview/src (a new view, a layout change, new styles in theme.css), and whenever the user says a view looks bad, ugly, cluttered or hard to read, or asks to make one look better or more consistent.
---

# Overlord webview design

The Connectors (MCP) view is the reference. Open `webview/src/views/connectors-view.tsx`
and `connectors-registry.tsx` next to whatever you are building and copy what they do.
Every view should look like it came from the same place.

## 1. Pick the layout

- **Cards** for a collection you scan: connectors, servers, tips, profiles, anything where
  each item has a name, a state, a line or two of detail and a button. Use
  `CardGroup`, `CardGrid` and `Card` from `webview/src/components/card.tsx`.
- **A table** (`DataTable`) for rows you sort and compare by column: sessions, usage,
  activity. Do not turn a table into cards just to look modern.
- **Group by what needs doing.** Put "Needs attention" before "Ready", each a
  `CardGroup` with its count. An empty group renders nothing, so you do not need to check.

## 2. Build the page from the shared pieces

The pieces live in `webview/src/components/card.tsx` and the "Cards and groups" section of
`webview/src/theme.css`. Use them instead of writing new classes for the same thing.

| Need                                                           | Use                                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A grid of cards under a heading with a count                   | `CardGroup`                                                                 |
| A grid with no heading, or large cards that open in place      | `CardGrid` (`wide` for large ones)                                          |
| One card, with a colored left edge for its state               | `Card tone="good"` (or warning, critical, info)                             |
| A card with buttons, or one opened to show a form              | `Card action`, `Card open`                                                  |
| The state at a glance                                          | `StatusDot` next to the title, plus a `Badge` in words when it is a problem |
| A tile that tells similar items apart                          | `Avatar seed={id} text={title}`                                             |
| A filter or mode switch                                        | `Segmented`                                                                 |
| What an action did, or why it failed                           | `Notice ok={...}`                                                           |
| The few numbers a page is about                                | `StatTiles` with a `StatTile` each (`detail`, `tone`, `title`)              |
| An element that is not a list item but should look like a card | `cardClassName({ tone })` on an `<article>` or `<div>`                      |

Inside a card, use these classes: `card-head` (the top row), `card-title`, `card-titles`
(a title with a `card-sub` line under it), `card-text` (muted detail, add `card-clamp` to
cut it at three lines), `card-foot` (chips and buttons, pinned to the bottom) and `chip`
for small labels. For a form inside an open card, use `card-form`, `form-grid` and
`form-actions`. Use `search-bar`, `list-bar` and `load-more` around a list, and
`empty-line` for "nothing here yet".

For tables and sections, `panel` frames a section with a heading (`panel-head`), and
`<details className="panel">` makes it fold away with a count in the summary.
`table-card` frames a bare sortable table so it sits well next to cards. `chip-list` is a
row of chips with no bullets, `pill-check` draws a checkbox as a toggle pill, and
`choice-grid` with `choice` lays radio buttons out as cards, each with room for a line
of explanation.

If you need something the pieces do not cover, add it to card.tsx and theme.css so the
next view gets it too. Only add page-specific classes for things that really are
page-specific, and put them in that view's own section of theme.css.

## 3. Rules

- **Theme colors only.** Every color comes from a `--ov-*` variable, so light, dark and
  high contrast themes all work. No hex colors, except white text on an avatar.
- **Same color, same meaning.** Green is ready, yellow needs a sign in or approval, red
  failed or missing, blue is information. Never say a state with color alone: the dot
  goes with a word.
- **One blue button per task.** `className="primary"` goes on the button that does the
  thing (Install, Sign in, Search). Everything else uses the default button, and links
  that leave Overlord use `link-button`.
- **Put the header to work.** The `view-header` holds the title, the counts that matter
  and the refresh controls on the right. Explanations most people read once go in a
  collapsed `<details className="about">` with the summary "How this works", not in a
  paragraph above the content.
- **Keep it compact.** This is a tool people glance at, not a landing page. Cards keep
  10 to 12 px of padding, and text in a card is short.
- **Accessible names stay.** Tests find things by role and name, and every view passes
  axe. Give lists a label, keep a visible or `aria-label` name on every input, and keep
  hints outside the `<label>` with `aria-describedby`.

## 4. Look at it before you commit

Run the preview script and look at all three screenshots:

```sh
node scripts/preview-view.mjs <view>
node scripts/preview-view.mjs connectors --click "Install…"
```

It builds the webview, hands the view the sample state in `webview/preview/<view>.json`,
and saves `<view>-light-wide.png`, `<view>-dark-wide.png` and `<view>-dark-narrow.png`
under `.cache/preview/`. Each `--click` presses the first button with that text, so you
can show an open form or menu. `--state file.json` uses another state file, and
`--narrow 340` sets the narrow shot's width, which is how to check a sidebar view such as
Session Properties.

If the view has no sample yet, write `webview/preview/<view>.json` with its state as
`src/shared/protocol.ts` types it, and make the data look real: a mix of states, long and
short names, and an empty or error case if the view has one. Commit the sample with the
view so the next session can preview it too.

Check that nothing overflows its card at 700 px, that both themes read clearly, and that
the page still makes sense with one item and with fifty. Fix what you see, then commit.
