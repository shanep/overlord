---
name: install-overlord
description: Package Overlord, install it into VS Code and reload the windows onto the new build, all without the user doing anything. Use after committing any change to Overlord the user should see, and whenever the user asks to install, deploy, update or reload the extension, or asks whether a change is installed.
---

# Install Overlord

Shane wants every change installed and running in VS Code without being asked
and without pressing Reload Window himself.

1. Commit the change first. The script builds `HEAD` in a temporary worktree,
   so uncommitted edits are not installed. Other sessions often have
   uncommitted work in this checkout, and this keeps it out of the build.
2. From the repo root run:

   ```sh
   npm run install:local
   ```

   It packages the extension, runs `code --install-extension --force`, then
   waits up to 60 seconds for a VS Code window to reload onto the new build.
   Installed copies of Overlord poll their own `dist/extension.cjs`, reload the
   window when it is replaced, and write `~/.overlord/loaded.json` with the
   mtime of the bundle they loaded. The script waits for that mtime to match
   the installed file. Builds from before the hook socket moved wrote the
   marker to `~/.claude/overlord/loaded.json`, so the script checks there
   too.

   Once the window reloads, the new build builds every view from the real
   data on this machine and writes `~/.overlord/check.json`. The
   script waits for it (up to 90 seconds) and prints how many views built,
   any that failed or are slow, and errors the sources reported. A failed
   view exits 1: the change breaks on real data, so fix it before moving on.

3. Report the result in one line: installed and reloaded, held, or what failed,
   plus the self-check's result.
   **"Held"** means a window has Launcher runs going. A reload would end them,
   so the window waits for them to finish and then reloads on its own. The
   install worked and there is nothing more to do.

## When it fails

- **"HEAD is N commits behind origin/master"**: the build would drop what
  other sessions landed since this branch was cut, and roll the installed
  Overlord back. Run `git fetch origin master && git rebase origin/master`,
  then install again. Pass `--allow-behind` only to install an older build on
  purpose.
- **"no window reloaded within 60 seconds"**: the running window has a build
  from before auto reload existed (or VS Code is closed). The install itself
  worked. Ask Shane to run Developer: Reload Window once. Every install after
  that reloads on its own.
- **`code: command not found`**: the VS Code shell command is not on `PATH`.
  Ask Shane to run Shell Command: Install 'code' command in PATH.
- **Build or package errors**: fix them like any failed check, commit, and run
  the script again.

Every open VS Code window reloads, since each one runs the old build. Terminal
sessions survive a reload, including this Claude Code session, but the IDE
connection drops briefly and Claude Code prints a disconnected notice. That
notice is expected.
