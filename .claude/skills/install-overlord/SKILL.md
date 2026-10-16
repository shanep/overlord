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
   window when it is replaced, and write `~/.claude/overlord/loaded.json`
   with the mtime of the bundle they loaded. The script waits for that mtime
   to match the installed file.

3. Report the result in one line: installed and reloaded, or what failed.

## When it fails

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
