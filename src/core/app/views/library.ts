// The Skills and Agents views: the installed ones from the config inventory,
// and the premade ones from the catalog. Claude Code's built-in agents are
// left out, since there is nothing to do with them. Opening a view the first
// time lists its first source.

import type { CatalogKind, LibraryState } from '../../../shared/catalog.js';
import type { Runtime } from '../runtime.js';

export function buildLibrary(rt: Runtime, kind: CatalogKind): LibraryState {
  const browser = rt.catalogs[kind];
  browser.start();
  return {
    kind,
    installed: rt.caches.config.value.items.filter(
      (item) => item.kind === kind && item.scope !== 'built-in',
    ),
    catalog: browser.view(),
  };
}
