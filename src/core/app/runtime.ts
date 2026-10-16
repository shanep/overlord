// Everything the views, actions and commands share. OverlordApp builds one
// and hands it around, so each piece takes a single argument.

import type { LaunchProfile } from '../../shared/model.js';
import type { ConfigState, PlanLimits, UsageStats } from '../../shared/protocol.js';
import type { EventBus } from '../bus.js';
import type { FileSystem } from '../context/fs.js';
import type { Launcher } from '../harness/launcher.js';
import type { ClaudePaths } from '../paths.js';
import type { OverlordStore } from '../store/store.js';
import type { ExecFunction as SurfacesExec, IsAlive } from '../surfaces/process.js';
import type { Exec } from '../sync/exec.js';

import type { AsyncValue } from './async-value.js';
import type { HostPort } from './host-port.js';
import type { BackgroundJobs } from './jobs.js';
import type { PermissionHub } from './permissions.js';
import type { SessionPlaces } from './places.js';
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
  readonly usage: AsyncValue<UsageStats>;
  readonly plan: AsyncValue<PlanLimits | null>;
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
  /** Waits ms milliseconds. Tests pass one that returns at once. */
  readonly delay: (ms: number) => Promise<void>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hostname: string;
  readonly platform: NodeJS.Platform;
  readonly fs: FileSystem;
  readonly store: OverlordStore;
  readonly launcher: Launcher;
  readonly permissions: PermissionHub;
  /** Where each live session runs, for the fleet. */
  readonly places: SessionPlaces;
  /** Background jobs waiting on the user or finished, for the fleet. */
  readonly jobs: BackgroundJobs;
  readonly caches: Caches;
  readonly context: ContextViews;
  /** Sends a source.error to the bus, which also lands in the status error list. */
  readonly report: (source: string, message: string) => void;
  /** Asks the CLI for the plan limits /usage shows. Resolves to the raw reply. */
  readonly planUsage: () => Promise<unknown>;
  /** Tells open panels to re-render. */
  readonly notify: () => void;
  /** Loads a session's transcript into the store, even an old one. True when it was found. */
  readonly openTranscript: (sessionId: string) => Promise<boolean>;
}
