// JSON helpers that keep unknown data unknown until it is checked.

export type JsonRecord = Readonly<Record<string, unknown>>;

/** Array.isArray narrows unknown to any[], so this keeps the elements unknown. */
export function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !isArray(value);
}

/** A key's own value. Plain indexing would also find inherited names such as toString. */
export function ownValue(record: JsonRecord, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Set a key as an own property. Plain assignment of "__proto__" would replace
 * the object's prototype instead, and JSON from a file can hold that key.
 */
export function setOwn(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** Parse JSON, returning undefined instead of throwing on bad input. */
export function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

/** Code unit order, so sorting is the same on every machine and locale. */
export function compareStrings(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** A copy with every object's keys sorted, so output does not depend on insertion order. */
export function sortKeysDeep(value: unknown): unknown {
  if (isArray(value)) {
    return value.map((entry: unknown) => sortKeysDeep(entry));
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).toSorted(compareStrings);
    return Object.fromEntries(keys.map((key) => [key, sortKeysDeep(value[key])]));
  }
  return value;
}

/** Pretty JSON with sorted keys and a trailing newline. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/** Structural equality for JSON values, ignoring key order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

export function stringRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return Object.fromEntries(entries);
}
