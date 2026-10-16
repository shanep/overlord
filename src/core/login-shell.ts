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

// SDK runs need the same environment. VS Code resolves it by running the login
// shell once and reading its env, so do that too. Markers fence the output
// because an interactive shell can print a banner or prompt around it.

export const ENV_MARKER = '__OVERLORD_ENV__';

/** Variables that describe the throwaway shell itself, not the user's setup. */
const SHELL_ONLY = new Set(['_', 'OLDPWD', 'PWD', 'SHLVL']);

export interface ShellInput {
  /** The user's $SHELL, when set. */
  readonly shell: string | undefined;
  readonly platform: NodeJS.Platform;
}

/** The command that prints the login shell's environment, or null on Windows. */
export function loginShellEnvLaunch(input: ShellInput): Launch | null {
  if (input.platform === 'win32') {
    return null;
  }
  const shell =
    input.shell === undefined || input.shell === '' ? defaultShell(input.platform) : input.shell;
  const fence = `printf '%s' ${ENV_MARKER}`;
  return { shellPath: shell, shellArgs: ['-l', '-i', '-c', `${fence}; env -0; ${fence}`] };
}

/** Reads `env -0` output between the markers. Null when the markers are missing. */
export function parseShellEnv(stdout: string): Record<string, string> | null {
  const start = stdout.indexOf(ENV_MARKER);
  const end = stdout.lastIndexOf(ENV_MARKER);
  if (start === -1 || end === start) {
    return null;
  }
  const env: Record<string, string> = {};
  for (const entry of stdout.slice(start + ENV_MARKER.length, end).split('\0')) {
    const equals = entry.indexOf('=');
    if (equals > 0) {
      const key = entry.slice(0, equals);
      if (!SHELL_ONLY.has(key)) {
        env[key] = entry.slice(equals + 1);
      }
    }
  }
  return env;
}
