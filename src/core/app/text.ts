// Small helpers for the plain messages the app shows.

/** "1 run", "3 runs". */
export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The first 8 characters of an id, enough to tell sessions apart in a message. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
