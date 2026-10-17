// The session-wide facts Copilot's events name once and then change: the
// version that wrote the file, model, effort, mode, folder, branch and title.

import type { Envelope, SessionResume } from './events.js';
import {
  modeChangedSchema,
  modelChangeSchema,
  sessionResumeSchema,
  sessionStartSchema,
  titleSchema,
} from './events.js';

/** The event types SessionFields reads. */
export const SESSION_FIELD_EVENTS: ReadonlySet<string> = new Set([
  'session.start',
  'session.resume',
  'session.model_change',
  'session.mode_changed',
  'session.title_changed',
]);

/** What session.start and session.resume both say about the session they open. */
type Opened = SessionResume;

export class SessionFields {
  version: string | null = null;
  model: string | null = null;
  effort: string | null = null;
  mode: string | null = null;
  cwd: string | null = null;
  gitBranch: string | null = null;
  title: string | null = null;

  /** Reads one of SESSION_FIELD_EVENTS. A field the event does not carry keeps its value. */
  apply(event: Envelope): void {
    switch (event.type) {
      case 'session.start': {
        const parsed = sessionStartSchema.safeParse(event.data);
        if (parsed.success) {
          this.version = parsed.data.copilotVersion ?? this.version;
          this.opened(parsed.data);
        }
        return;
      }
      case 'session.resume': {
        const parsed = sessionResumeSchema.safeParse(event.data);
        if (parsed.success) {
          this.opened(parsed.data);
        }
        return;
      }
      default: {
        this.changed(event);
      }
    }
  }

  private changed(event: Envelope): void {
    switch (event.type) {
      case 'session.model_change': {
        const parsed = modelChangeSchema.safeParse(event.data);
        if (parsed.success) {
          this.model = parsed.data.newModel ?? this.model;
          this.effort = parsed.data.reasoningEffort ?? this.effort;
        }
        return;
      }
      case 'session.mode_changed': {
        const parsed = modeChangedSchema.safeParse(event.data);
        this.mode = (parsed.success ? parsed.data.newMode : null) ?? this.mode;
        return;
      }
      default: {
        const parsed = titleSchema.safeParse(event.data);
        this.title = (parsed.success ? parsed.data.title : null) ?? this.title;
      }
    }
  }

  private opened(data: Opened): void {
    this.model = data.selectedModel ?? this.model;
    this.effort = data.reasoningEffort ?? this.effort;
    this.cwd = data.context?.cwd ?? this.cwd;
    this.gitBranch = data.context?.branch ?? this.gitBranch;
  }
}
