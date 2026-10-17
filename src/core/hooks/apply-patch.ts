// The files a Codex apply_patch call writes. Codex puts the whole patch in
// one input field, so the paths come from its file headers and not from a
// path field like Claude's file_path.

/** A header that names a file the patch adds, changes, deletes or moves a file to. */
const HEADER = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/u;

/** Every file a patch touches, once each, in the order it names them. */
export function patchPaths(patch: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/u)) {
    const file = HEADER.exec(line.trim())?.[1]?.trim();
    if (file !== undefined && file !== '') {
      paths.add(file);
    }
  }
  return [...paths];
}

/** The fields that can hold the patch: a string, or an argv like ["apply_patch", patch]. */
const PATCH_FIELDS: ReadonlySet<string> = new Set(['command', 'patch', 'input']);

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function texts(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }
  return isList(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** The files an apply_patch call writes, read from its input as a hook reports it. */
export function applyPatchPaths(input: unknown): readonly string[] {
  if (typeof input === 'string') {
    return patchPaths(input);
  }
  if (input === null || typeof input !== 'object') {
    return [];
  }
  const fields: readonly (readonly [string, unknown])[] = Object.entries(input);
  const paths = fields
    .filter(([field]) => PATCH_FIELDS.has(field))
    .flatMap(([, value]) => texts(value).flatMap((patch) => patchPaths(patch)));
  return [...new Set(paths)];
}
