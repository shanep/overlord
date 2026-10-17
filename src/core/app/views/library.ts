// The Skills and Agents views: the installed ones from the config inventory,
// and the premade ones from the catalog. Claude Code's built-in agents are
// left out, since there is nothing to do with them. Opening a view the first
// time lists its first source. Once another agent is in play, each installed
// one names the agents that read it, and what only those agents read is added.

import type { CatalogKind, LibraryState } from '../../../shared/catalog.js';
import { mergeLibrary } from '../../authoring/library.js';
import type { Runtime } from '../runtime.js';

export function buildLibrary(rt: Runtime, kind: CatalogKind): LibraryState {
  const browser = rt.catalogs[kind];
  browser.start();
  const scan = rt.caches.library.value;
  return {
    kind,
    installed: mergeLibrary({
      kind,
      installed: rt.caches.config.value.items.filter(
        (item) => item.kind === kind && item.scope !== 'built-in',
      ),
      found: scan[kind],
      readers: scan.readers,
      place: scan.place,
    }),
    catalog: browser.view(),
  };
}
