// POSIX shell quoting for commands Overlord types into a terminal.

const SAFE = /^[\w./:=@%+-]+$/u;

export function shellQuote(value: string): string {
  if (SAFE.test(value)) {
    return value;
  }
  const escaped = value.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

export function shellCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map((part) => shellQuote(part)).join(' ');
}
