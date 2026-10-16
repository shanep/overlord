// How Overlord starts claude in a terminal tab. VS Code opened from the Dock
// gets the bare macOS PATH (/usr/bin:/bin:...), so starting claude directly
// leaves it, and every command it runs, without Homebrew, nvm and the rest.
// A normal VS Code terminal fixes that by running the login shell, so do the
// same: the user's shell as a login, interactive shell that execs claude.

const SAFE = /^[\w./:=@%+-]+$/u;

/** POSIX shell quoting for one word. */
export function shellQuote(value: string): string {
  if (SAFE.test(value)) {
    return value;
  }
  const escaped = value.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

export interface LaunchInput {
  readonly command: string;
  readonly args: readonly string[];
  /** The user's $SHELL, when set. */
  readonly shell: string | undefined;
  readonly platform: NodeJS.Platform;
}

export interface Launch {
  readonly shellPath: string;
  readonly shellArgs: readonly string[];
}

function defaultShell(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

export function loginShellLaunch(input: LaunchInput): Launch {
  if (input.platform === 'win32') {
    // Windows terminals already inherit the full PATH.
    return { shellPath: input.command, shellArgs: [...input.args] };
  }
  const shell =
    input.shell === undefined || input.shell === '' ? defaultShell(input.platform) : input.shell;
  const line = [input.command, ...input.args].map((part) => shellQuote(part)).join(' ');
  // exec replaces the shell, so the tab still closes when claude exits.
  return { shellPath: shell, shellArgs: ['-l', '-i', '-c', `exec ${line}`] };
}
