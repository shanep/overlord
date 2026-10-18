// Knob definitions, settings layers and the value that takes effect.

export type KnobKind = 'setting' | 'env' | 'flag';
export type KnobValueType = 'boolean' | 'number' | 'string' | 'enum' | 'json' | 'string[]';
export type AppliesAt = 'live' | 'next-turn' | 'next-launch';

export interface KnobDefinition {
  readonly key: string;
  readonly kind: KnobKind;
  readonly area: string;
  readonly valueType: KnobValueType;
  readonly defaultValue: string | null;
  readonly allowed: readonly string[];
  readonly description: string;
  readonly docUrl: string;
  readonly appliesAt: AppliesAt;
  readonly managedOnly: boolean;
}

export type SettingsLayer =
  'managed' | 'cli' | 'project-local' | 'project' | 'user' | 'env' | 'default';

export interface EffectiveValue {
  readonly key: string;
  readonly value: unknown;
  readonly layer: SettingsLayer;
  /** Every layer that set this key, highest precedence first, including the winner. */
  readonly chain: readonly {
    readonly layer: SettingsLayer;
    readonly value: unknown;
    readonly file: string | null;
  }[];
}

/** One settings file Claude Code reads, for the Knobs view's file list. */
export interface SettingsFileSummary {
  readonly layer: SettingsLayer;
  readonly file: string;
  readonly exists: boolean;
  /** How many dotted keys the file sets. */
  readonly keys: number;
  /** Why the file could not be read, or null. */
  readonly error: string | null;
}
