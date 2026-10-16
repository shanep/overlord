// Handler types for webview actions, keyed by action type so each handler
// gets its own action shape.

import type { WebviewAction } from '../../shared/protocol.js';

import type { PanelParams } from './host-port.js';
import type { Runtime } from './runtime.js';

export type ActionMap = { readonly [A in WebviewAction as A['type']]: A };

export type ActionType = keyof ActionMap;

export interface ActionContext {
  readonly rt: Runtime;
  /** The params of the panel the action came from. */
  readonly params: PanelParams;
}

type ActionHandler<K extends ActionType> = (
  context: ActionContext,
  action: ActionMap[K],
) => Promise<void>;

export type ActionHandlers<K extends ActionType> = { readonly [T in K]: ActionHandler<T> };
