// The facets that carry Overlord's side of a session's talk: its telemetry,
// and how Overlord's own text reaches it. Kept apart from types.ts so that
// file stays under the length cap. Workstream D owns both.

import type { ConfigOverride } from '../knobs/facet.js';
import type { TelemetryDecode } from '../otel/decode.js';

/**
 * Where the app found an agent's files, so a facet can be pointed at a temp
 * folder in tests.
 */
export interface AgentDirs {
  readonly home: string;
  /** The agent's config folder: ~/.claude or CLAUDE_CONFIG_DIR, ~/.copilot, ~/.codex or CODEX_HOME. */
  readonly configDir: string;
}

export type SettingsWriteResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Turns on the agent's OTLP export and reads what it sends. The receiver and
 * the join of span timings onto requests are shared. Workstream D owns it.
 */
export interface TelemetryFacet {
  /** Points the agent's export at the receiver on 127.0.0.1:port. Prompts and tool details stay off. */
  enable: (dirs: AgentDirs, port: number) => Promise<SettingsWriteResult>;
  disable: (dirs: AgentDirs) => Promise<SettingsWriteResult>;
  /** Records from one export body, or null when it is not valid OTLP. */
  readonly decode: TelemetryDecode;
  /** True when the agent's own settings export to Overlord. Left out for Claude Code, whose env block Sources reads. */
  readonly enabled?: (dirs: AgentDirs) => Promise<boolean>;
  /**
   * Config overrides that point one launch's export at 127.0.0.1:port, for
   * sessions Overlord starts while its receiver runs. Empty when the user's
   * own settings export somewhere else, so Overlord never takes that over.
   */
  readonly launchConfig?: (dirs: AgentDirs, port: number) => Promise<readonly ConfigOverride[]>;
  /** True for the OTLP resource service.name the agent sends, so the receiver picks its decoder. */
  readonly sends?: (serviceName: string) => boolean;
}

/** The ways Overlord's text can reach a session. */
export type InjectRoute = 'hook' | 'launch-argument' | 'first-prompt';

/**
 * Best first. A hook answer reaches every session, Overlord's or not, at the
 * moment it matters. A launch argument only reaches sessions Overlord starts.
 * A first prompt prefix is the last resort, since it shows up in the
 * transcript as if the user typed it.
 */
export const INJECT_ORDER: readonly InjectRoute[] = ['hook', 'launch-argument', 'first-prompt'];

/**
 * How coordination notes, the launch check and the connector briefing reach
 * a session. Workstream D owns it.
 */
export interface InjectFacet {
  /** The routes the agent takes, in INJECT_ORDER. */
  readonly routes: readonly InjectRoute[];
  /**
   * True when sessions Overlord starts take the launch argument even with
   * hooks installed, because the agent may skip the hooks (Codex runs one
   * only once the user trusts it).
   */
  readonly launchFirst?: boolean;
  /** Arguments that add text to a new session's instructions. */
  readonly launchArgs?: (text: string) => readonly string[];
  /** The same text as config overrides, for a runtime that takes those (StartOptions.config). */
  readonly launchConfig?: (text: string) => readonly ConfigOverride[];
  /** The first prompt with Overlord's text in front of it. */
  readonly promptPrefix?: (text: string, prompt: string) => string;
}

/**
 * The best route for a session. A hook only counts while the agent's hooks
 * are installed, and the other two only when Overlord starts the session.
 */
export function injectRoute(
  facet: InjectFacet,
  usable: { readonly hooks: boolean; readonly launching: boolean },
): InjectRoute | null {
  const allowed = (route: InjectRoute): boolean => {
    if (route === 'hook') {
      return usable.hooks;
    }
    const supported =
      route === 'launch-argument'
        ? facet.launchArgs !== undefined
        : facet.promptPrefix !== undefined;
    return usable.launching && supported;
  };
  return INJECT_ORDER.find((route) => facet.routes.includes(route) && allowed(route)) ?? null;
}
