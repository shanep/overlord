// Every stylesheet the views use, in cascade order. theme.css holds the
// tokens and controls every view shares, layout.css and cards.css the shared
// layout pieces, and each other file one view. Keep the order: a later sheet
// wins a tie, and the files were cut from one sheet in this order.

import themeCss from '../theme.css?inline';

import activityCss from './activity.css?inline';
import agentDetailCss from './agent-detail.css?inline';
import agentFeedCss from './agent-feed.css?inline';
import cardsCss from './cards.css?inline';
import configCss from './config.css?inline';
import connectorsCss from './connectors.css?inline';
import contextCss from './context.css?inline';
import helpCss from './help.css?inline';
import knobsCss from './knobs.css?inline';
import launcherCss from './launcher.css?inline';
import layoutCss from './layout.css?inline';
import messagesCss from './messages.css?inline';
import propertiesCss from './properties.css?inline';
import sessionsCss from './sessions.css?inline';
import skillsCss from './skills.css?inline';
import tuningCss from './tuning.css?inline';
import usageCss from './usage.css?inline';

export const SHEETS: readonly string[] = [
  themeCss,
  usageCss,
  layoutCss,
  agentFeedCss,
  propertiesCss,
  helpCss,
  tuningCss,
  activityCss,
  cardsCss,
  sessionsCss,
  agentDetailCss,
  contextCss,
  knobsCss,
  configCss,
  launcherCss,
  connectorsCss,
  skillsCss,
  messagesCss,
];
