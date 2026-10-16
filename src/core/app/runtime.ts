// Everything the views, actions and commands share. OverlordApp builds one
// and hands it around, so each piece takes a single argument.

import type { LaunchProfile } from '../../shared/model.js';
import type { ConfigState, UsageState } from '../../shared/protocol.js';
import type { EventBus } from '../bus.js';
import type { FileSystem } from '../context/fs.js';
import type { Launcher } from '../harness/launcher.js';
import type { ClaudePaths } from '../paths.js';
import type { OverlordStore } from '../store/store.js';
import type { ExecFunction as SurfacesExec, IsAlive } from '../surfaces/process.js';
import type { Exec } from '../sync/exec.js';

import type { AsyncValue } from './async-value.js';
import type { HostPort } from './host-port.js';
import type { PermissionHub } from './permissions.js';
import type { KillFunction } from './process.js';
import type { Draft } from './storage.js';
import type { ContextViews } from './views/context.js';
import type { KnobsData } from './views/knobs.js';
import type { SessionsData } from './views/sessions.js';

export interface Caches {
  readonly knobs: AsyncValue<KnobsData>;
  readonly profiles: AsyncValue<readonly LaunchProfile[]>;
  readonly drafts: AsyncValue<readonly Draft[]>;
  readonly sessions: AsyncValue<SessionsData>;
  readonly config: AsyncValue<ConfigState>;
  readonly usage: AsyncValue<UsageState>;
}

export interface Runtime {
  readonly paths: ClaudePaths;
  readonly host: HostPort;
  readonly bus: EventBus;
  readonly clock: () => number;
  readonly exec: Exec;
  readonly surfacesExec: SurfacesExec;
  readonly isAlive: IsAlive;
  readonly kill: KillFunction;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hostname: string;
  readonly platform: NodeJS.Platform;
  readonly fs: FileSystem;
  readonly store: OverlordStore;
  readonly launcher: Launcher;
  readonly permissions: PermissionHub;
  readonly caches: Caches;
  readonly context: ContextViews;
  /** Sends a source.error to the bus, which also lands in the status error list. */
  readonly report: (source: string, message: string) => void;
  /** Tells open panels to re-render. */
  readonly notify: () => void;
}
